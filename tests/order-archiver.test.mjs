import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { buffer } from "node:stream/consumers";
import { S3Client } from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import {
	ArchiveFileError,
	FILE_OUTCOMES,
	archiveOrderFile,
	getArchiveJobStatus,
	recordFileResult,
	startArchiveJob,
} from "../src/app/server-functions/orders/orderArchiver.js";
import { createDecompressStream } from "../src/app/server-functions/orders/fileCompression.js";
import {
	renameOrderFile,
	setOrderFileChecksum,
} from "../src/app/server-functions/orders/orderFiles.js";
import { encodeMetadataValue } from "../src/app/server-functions/MinIO/metadataEncoding.js";

const BUCKET = "projecto";
const FILE_ID = "01900000-0000-7000-8000-000000000001";
const NOW = new Date("2026-11-11T10:00:00.000Z");

const sha = (data) => createHash("sha256").update(data).digest("hex");

function compressibleData()
{
	const lines = [];

	for (let i = 0; i < 3000; i++)
	{
		lines.push(`  facet normal ${(i % 11) / 11} 0 1\n    vertex ${i} ${i * 3} ${i % 9}\n  endfacet\n`);
	}

	return Buffer.from(lines.join(""));
}

function metadataFromHeaders(headers)
{
	const metadata = {};

	for (const [name, value] of Object.entries(headers))
	{
		if (name.startsWith("x-amz-meta-"))
		{
			metadata[name.slice("x-amz-meta-".length)] = value;
		}
	}

	return metadata;
}

const md5Etag = (body) => `"${createHash("md5").update(body).digest("hex")}"`;

// Like S3/MinIO: the ETag follows the content, so a metadata-only copy keeps it.
const etagOf = (object) => object.etag ?? md5Etag(object.body);

function objectHeaders(object)
{
	return {
		"Content-Length": String(object.body.length),
		"Content-Type": object.contentType ?? "application/octet-stream",
		ETag: etagOf(object),
		...Object.fromEntries(Object.entries(object.metadata).map(([name, value]) => [`x-amz-meta-${name}`, value])),
	};
}

function sendNotFound(req, res)
{
	if (req.method === "HEAD")
	{
		res.writeHead(404).end();
		return;
	}

	res.writeHead(404, { "Content-Type": "application/xml" }).end(
		"<Error><Code>NoSuchKey</Code><Message>The specified key does not exist.</Message></Error>",
	);
}

function sendError(res, status, code)
{
	res.writeHead(status, { "Content-Type": "application/xml" }).end(
		`<Error><Code>${code}</Code><Message>${code}</Message></Error>`,
	);
}

// Applies an If-Match header to a write of key: false (and the error sent)
// when the current object does not match.
function checkIfMatch(req, res, objects, key, ifMatch, counters)
{
	if (ifMatch === undefined)
	{
		return true;
	}

	const current = objects.get(key);

	if (!current)
	{
		counters.rejected++;
		sendNotFound(req, res);
		return false;
	}

	if (etagOf(current) !== ifMatch)
	{
		counters.rejected++;
		sendError(res, 412, "PreconditionFailed");
		return false;
	}

	return true;
}

// S3 stand-in with Head/Get/Put/Copy (self-copy with REPLACE metadata)/Delete
// and the multipart calls, built like withS3 in multipart-upload.test.mjs.
// PutObject and CompleteMultipartUpload honour If-Match, CopyObject honours
// x-amz-copy-source-if-match.
// corruptPuts: number of following PutObject bodies to store with a flipped byte.
// beforePut / beforeCopy({ objects, key, index }): called before the request
//   is handled (index counts from 0); may change objects, or return an HTTP
//   status to fail the request with.
async function withS3(fn, { corruptPuts = 0, beforePut, beforeCopy } = {})
{
	const objects = new Map();
	const multipart = new Map();
	const counters = { put: 0, copy: 0, delete: 0, rejected: 0, putAttempts: 0, copyAttempts: 0 };
	const requests = [];
	let corruptRemaining = corruptPuts;

	const server = http.createServer((req, res) =>
	{
		const chunks = [];

		req.on("data", (chunk) => chunks.push(chunk));
		req.on("end", () =>
		{
			const url = new URL(req.url, "http://localhost");
			const key = decodeURIComponent(url.pathname.split("/").slice(2).join("/"));
			const requestBody = Buffer.concat(chunks);

			requests.push({ method: req.method, search: url.search, headers: req.headers });

			if (req.method === "POST" && url.searchParams.has("uploads"))
			{
				multipart.set("u1", {
					key,
					contentType: req.headers["content-type"],
					metadata: metadataFromHeaders(req.headers),
					parts: new Map(),
				});
				res.writeHead(200, { "Content-Type": "application/xml" }).end(
					"<InitiateMultipartUploadResult><UploadId>u1</UploadId></InitiateMultipartUploadResult>",
				);
				return;
			}

			if (req.method === "PUT" && url.searchParams.has("partNumber"))
			{
				multipart.get(url.searchParams.get("uploadId")).parts.set(
					Number(url.searchParams.get("partNumber")),
					requestBody,
				);
				res.writeHead(200, { ETag: `"part${url.searchParams.get("partNumber")}"` }).end();
				return;
			}

			if (req.method === "POST" && url.searchParams.has("uploadId"))
			{
				const upload = multipart.get(url.searchParams.get("uploadId"));

				if (!checkIfMatch(req, res, objects, upload.key, req.headers["if-match"], counters))
				{
					return;
				}

				const body = Buffer.concat([...upload.parts.entries()].sort((a, b) => a[0] - b[0]).map(([, part]) => part));
				const etag = `"${createHash("md5").update(body).digest("hex")}-${upload.parts.size}"`;

				counters.put++;
				multipart.delete(url.searchParams.get("uploadId"));
				objects.set(upload.key, { body, etag, contentType: upload.contentType, metadata: upload.metadata });
				res.writeHead(200, { "Content-Type": "application/xml" }).end(
					`<CompleteMultipartUploadResult><ETag>${etag.replaceAll("\"", "&quot;")}</ETag></CompleteMultipartUploadResult>`,
				);
				return;
			}

			if (req.method === "DELETE" && url.searchParams.has("uploadId"))
			{
				multipart.delete(url.searchParams.get("uploadId"));
				res.writeHead(204).end();
				return;
			}

			if (req.method === "PUT" && req.headers["x-amz-copy-source"])
			{
				const failStatus = beforeCopy?.({ objects, key, index: counters.copyAttempts++ });

				if (failStatus)
				{
					sendError(res, failStatus, "InternalError");
					return;
				}

				const sourceKey = decodeURIComponent(req.headers["x-amz-copy-source"].split("/").slice(1).join("/"));
				const source = objects.get(sourceKey);

				if (!source)
				{
					sendNotFound(req, res);
					return;
				}

				const copyIfMatch = req.headers["x-amz-copy-source-if-match"];

				if (copyIfMatch !== undefined && copyIfMatch !== etagOf(source))
				{
					counters.rejected++;
					sendError(res, 412, "PreconditionFailed");
					return;
				}

				const replace = req.headers["x-amz-metadata-directive"] === "REPLACE";
				const etag = etagOf(source);

				counters.copy++;
				objects.set(key, {
					body: source.body,
					etag,
					contentType: replace ? req.headers["content-type"] : source.contentType,
					metadata: replace ? metadataFromHeaders(req.headers) : { ...source.metadata },
				});
				res.writeHead(200, { "Content-Type": "application/xml" }).end(
					`<CopyObjectResult><ETag>${etag.replaceAll("\"", "&quot;")}</ETag></CopyObjectResult>`,
				);
				return;
			}

			if (req.method === "PUT")
			{
				const failStatus = beforePut?.({ objects, key, index: counters.putAttempts++ });

				if (failStatus)
				{
					sendError(res, failStatus, "InternalError");
					return;
				}

				if (!checkIfMatch(req, res, objects, key, req.headers["if-match"], counters))
				{
					return;
				}

				let body = requestBody;

				if (corruptRemaining > 0)
				{
					corruptRemaining--;
					body = Buffer.from(body);
					body[body.length - 1] ^= 0xff;
				}

				counters.put++;
				objects.set(key, {
					body,
					contentType: req.headers["content-type"],
					metadata: metadataFromHeaders(req.headers),
				});
				res.writeHead(200, { ETag: md5Etag(body) }).end();
				return;
			}

			if (req.method === "HEAD" || req.method === "GET")
			{
				const object = objects.get(key);

				if (!object)
				{
					sendNotFound(req, res);
					return;
				}

				res.writeHead(200, objectHeaders(object));
				res.end(req.method === "GET" ? object.body : undefined);
				return;
			}

			if (req.method === "DELETE")
			{
				counters.delete++;
				objects.delete(key);
				res.writeHead(204).end();
				return;
			}

			res.writeHead(400).end();
		});
	});

	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

	const s3 = new S3Client({
		region: "us-east-1",
		endpoint: `http://127.0.0.1:${server.address().port}`,
		forcePathStyle: true,
		credentials: { accessKeyId: "a", secretAccessKey: "b" },
		maxAttempts: 1,
	});

	try
	{
		await fn(s3, { objects, counters, requests });
	}
	finally
	{
		s3.destroy();
		server.close();
	}
}

function seed(objects, body, metadata = {})
{
	objects.set(FILE_ID, {
		body,
		contentType: "model/stl",
		metadata: {
			original_name: encodeMetadataValue("Skan górny.stl"),
			...metadata,
		},
	});
}

const decompress = (method, data) => buffer(Readable.from([data]).pipe(createDecompressStream(method)));

async function archiverTempFiles()
{
	return (await readdir(os.tmpdir())).filter((name) => name.startsWith("projecto-archive-"));
}

test("compresses a compressible file in place and keeps its metadata", async () =>
{
	const data = compressibleData();
	const tempBefore = await archiverTempFiles();

	await withS3(async (s3, { objects, counters }) =>
	{
		seed(objects, data, { sha256: sha(data) });

		const result = await archiveOrderFile({ s3, fileId: FILE_ID, now: () => NOW });
		const stored = objects.get(FILE_ID);

		assert.equal(result.outcome, FILE_OUTCOMES.compressed);
		assert.ok(["zstd", "br"].includes(result.method));
		assert.equal(result.originalSize, data.length);
		assert.equal(result.storedSize, stored.body.length);
		assert.ok(stored.body.length < data.length / 5);
		assert.equal(stored.contentType, "model/stl");
		assert.equal(stored.metadata.compression, result.method);
		assert.equal(stored.metadata.original_size, String(data.length));
		assert.equal(stored.metadata.archived_at, NOW.toISOString());
		assert.equal(stored.metadata.sha256, sha(data));
		assert.equal(stored.metadata.original_name, encodeMetadataValue("Skan górny.stl"));
		assert.ok((await decompress(result.method, stored.body)).equals(data));

		// A second run leaves the archived object alone.
		const putsBefore = counters.put;
		const again = await archiveOrderFile({ s3, fileId: FILE_ID });

		assert.equal(again.outcome, FILE_OUTCOMES.alreadyArchived);
		assert.equal(again.originalSize, data.length);
		assert.equal(counters.put, putsBefore);
		assert.equal(counters.copy, 0);
	});

	assert.deepEqual(await archiverTempFiles(), tempBefore);
});

test("stores the computed sha256 when the file had none", async () =>
{
	const data = compressibleData();

	await withS3(async (s3, { objects }) =>
	{
		seed(objects, data);

		const result = await archiveOrderFile({ s3, fileId: FILE_ID });

		assert.equal(result.outcome, FILE_OUTCOMES.compressed);
		assert.equal(objects.get(FILE_ID).metadata.sha256, sha(data));
	});
});

test("an incompressible file keeps its bytes and gets identity metadata", async () =>
{
	const data = randomBytes(32 * 1024);

	await withS3(async (s3, { objects, counters }) =>
	{
		seed(objects, data);

		const result = await archiveOrderFile({ s3, fileId: FILE_ID, now: () => NOW });
		const stored = objects.get(FILE_ID);

		assert.equal(result.outcome, FILE_OUTCOMES.incompressible);
		assert.equal(result.method, "identity");
		assert.ok(stored.body.equals(data));
		assert.equal(counters.put, 0);
		assert.equal(stored.contentType, "model/stl");
		assert.equal(stored.metadata.compression, "identity");
		assert.equal(stored.metadata.original_size, String(data.length));
		assert.equal(stored.metadata.archived_at, NOW.toISOString());
		assert.equal(stored.metadata.sha256, sha(data));
		assert.equal(stored.metadata.original_name, encodeMetadataValue("Skan górny.stl"));

		const again = await archiveOrderFile({ s3, fileId: FILE_ID });

		assert.equal(again.outcome, FILE_OUTCOMES.alreadyArchived);
		assert.equal(counters.copy, 1);
	});
});

test("a stored sha256 that does not match leaves the object untouched", async () =>
{
	const data = compressibleData();
	const tempBefore = await archiverTempFiles();

	await withS3(async (s3, { objects, counters }) =>
	{
		seed(objects, data, { sha256: sha("something else") });

		const before = structuredClone(objects.get(FILE_ID));

		await assert.rejects(archiveOrderFile({ s3, fileId: FILE_ID }), ArchiveFileError);

		const after = objects.get(FILE_ID);

		assert.ok(after.body.equals(data));
		assert.deepEqual(after.metadata, before.metadata);
		assert.equal(counters.put, 0);
		assert.equal(counters.copy, 0);
	});

	assert.deepEqual(await archiverTempFiles(), tempBefore);
});

test("restores the original when the stored archive fails read-back", async () =>
{
	const data = compressibleData();

	await withS3(async (s3, { objects, counters }) =>
	{
		seed(objects, data, { sha256: sha(data) });

		await assert.rejects(archiveOrderFile({ s3, fileId: FILE_ID }), ArchiveFileError);

		const stored = objects.get(FILE_ID);

		assert.equal(counters.put, 2);
		assert.ok(stored.body.equals(data));
		assert.equal(stored.metadata.compression, undefined);
		assert.equal(stored.metadata.sha256, sha(data));
		assert.equal(stored.contentType, "model/stl");
	}, { corruptPuts: 1 });
});

test("a missing object fails the file", async () =>
{
	await withS3(async (s3) =>
	{
		await assert.rejects(archiveOrderFile({ s3, fileId: FILE_ID }));
	});
});

test("deletes the archived object when its order was removed meanwhile", async () =>
{
	const data = compressibleData();

	await withS3(async (s3, { objects, counters }) =>
	{
		seed(objects, data, { sha256: sha(data) });

		const result = await archiveOrderFile({
			s3,
			fileId: FILE_ID,
			isStillAttached: async () => false,
		});

		assert.equal(result.outcome, FILE_OUTCOMES.orphaned);
		assert.equal(objects.has(FILE_ID), false);
		assert.equal(counters.delete, 1);
	});
});

test("recordFileResult counts bytes only for files handled in this run", () =>
{
	const status = {
		filesCompressed: 0,
		filesSkipped: 0,
		filesAlreadyArchived: 0,
		filesIncompressible: 0,
		filesOrphaned: 0,
		filesChanged: 0,
		bytesBefore: 0,
		bytesAfter: 0,
	};

	recordFileResult(status, { outcome: FILE_OUTCOMES.compressed, originalSize: 100, storedSize: 20 });
	recordFileResult(status, { outcome: FILE_OUTCOMES.incompressible, originalSize: 50, storedSize: 50 });
	recordFileResult(status, { outcome: FILE_OUTCOMES.alreadyArchived, originalSize: 999, storedSize: 9 });
	recordFileResult(status, { outcome: FILE_OUTCOMES.changed, originalSize: 70, storedSize: null });

	assert.equal(status.filesCompressed, 1);
	assert.equal(status.filesSkipped, 2);
	assert.equal(status.filesIncompressible, 1);
	assert.equal(status.filesAlreadyArchived, 1);
	assert.equal(status.filesChanged, 1);
	assert.equal(status.bytesBefore, 150);
	assert.equal(status.bytesAfter, 70);
});

// ---- Concurrent writers ----

// What the archiver would store for data: different bytes, compression marker.
function archivedVersion(data)
{
	return {
		body: Buffer.concat([Buffer.from("compressed:"), data.subarray(0, 64)]),
		contentType: "model/stl",
		metadata: {
			original_name: encodeMetadataValue("Skan górny.stl"),
			sha256: sha(data),
			compression: "zstd",
			original_size: String(data.length),
		},
	};
}

test("a metadata update retries on a fresh read when the bytes were replaced meanwhile", async () =>
{
	const data = compressibleData();

	await withS3(async (s3, { objects, counters }) =>
	{
		seed(objects, data);

		const replaced = archivedVersion(data);
		const renamed = await renameOrderFile(s3, FILE_ID, "Nowa nazwa.stl");
		const stored = objects.get(FILE_ID);

		assert.equal(renamed, true);
		assert.equal(counters.rejected, 1);
		assert.equal(counters.copy, 1);
		assert.ok(stored.body.equals(replaced.body));
		assert.equal(stored.metadata.compression, "zstd");
		assert.equal(stored.metadata.original_size, String(data.length));
		assert.equal(stored.metadata.sha256, sha(data));
		assert.equal(stored.metadata.original_name, encodeMetadataValue("Nowa nazwa.stl"));
	}, {
		// The archiver replaces the object between the HEAD and the copy.
		beforeCopy: ({ objects, index }) =>
		{
			if (index === 0)
			{
				objects.set(FILE_ID, archivedVersion(compressibleData()));
			}
		},
	});
});

test("a metadata update that is no longer needed after the retry copies nothing", async () =>
{
	const data = compressibleData();

	await withS3(async (s3, { objects, counters }) =>
	{
		seed(objects, data);

		assert.equal(await setOrderFileChecksum(s3, FILE_ID, sha(data)), false);
		assert.equal(counters.rejected, 1);
		assert.equal(counters.copy, 0);
		assert.equal(objects.get(FILE_ID).metadata.compression, "zstd");
	}, {
		beforeCopy: ({ objects, index }) =>
		{
			if (index === 0)
			{
				objects.set(FILE_ID, archivedVersion(compressibleData()));
			}
		},
	});
});

test("a metadata update gives up after repeated precondition failures", async () =>
{
	const data = compressibleData();

	await withS3(async (s3, { objects, counters }) =>
	{
		seed(objects, data);

		await assert.rejects(
			renameOrderFile(s3, FILE_ID, "Nowa nazwa.stl"),
			(err) => err.name === "PreconditionFailed",
		);
		assert.equal(counters.copyAttempts, 3);
		assert.equal(counters.copy, 0);
	}, {
		beforeCopy: ({ objects, index }) =>
		{
			objects.set(FILE_ID, { ...archivedVersion(data), body: Buffer.from(`version ${index}`) });
		},
	});
});

test("an object replaced before the archive is written is left alone", async () =>
{
	const data = compressibleData();
	const other = { body: Buffer.from("someone else's bytes"), contentType: "model/stl", metadata: { x: "1" } };

	await withS3(async (s3, { objects, counters }) =>
	{
		seed(objects, data, { sha256: sha(data) });

		const result = await archiveOrderFile({ s3, fileId: FILE_ID });

		assert.equal(result.outcome, FILE_OUTCOMES.changed);
		assert.equal(counters.put, 0);
		assert.equal(counters.rejected, 1);
		assert.equal(objects.get(FILE_ID), other);
	}, {
		beforePut: ({ objects, index }) =>
		{
			if (index === 0)
			{
				objects.set(FILE_ID, other);
			}
		},
	});
});

test("an object deleted before the archive is written is not recreated", async () =>
{
	const data = compressibleData();

	await withS3(async (s3, { objects, counters }) =>
	{
		seed(objects, data, { sha256: sha(data) });

		const result = await archiveOrderFile({ s3, fileId: FILE_ID });

		assert.equal(result.outcome, FILE_OUTCOMES.changed);
		assert.equal(objects.has(FILE_ID), false);
		assert.equal(counters.put, 0);
	}, {
		// deleteOrder removes the objects before the row.
		beforePut: ({ objects, index }) =>
		{
			if (index === 0)
			{
				objects.delete(FILE_ID);
			}
		},
	});
});

test("a failed read-back after the order was deleted removes the object instead of restoring it", async () =>
{
	const data = compressibleData();

	await withS3(async (s3, { objects, counters }) =>
	{
		seed(objects, data, { sha256: sha(data) });

		const result = await archiveOrderFile({
			s3,
			fileId: FILE_ID,
			isStillAttached: async () => false,
		});

		assert.equal(result.outcome, FILE_OUTCOMES.orphaned);
		assert.equal(objects.has(FILE_ID), false);
		assert.equal(counters.put, 1);
		assert.equal(counters.delete, 1);
	}, { corruptPuts: 1 });
});

test("a failed read-back of an object deleted meanwhile is not restored", async () =>
{
	const data = compressibleData();

	await withS3(async (s3, { objects, counters }) =>
	{
		seed(objects, data, { sha256: sha(data) });

		const result = await archiveOrderFile({ s3, fileId: FILE_ID });

		assert.equal(result.outcome, FILE_OUTCOMES.changed);
		assert.equal(objects.has(FILE_ID), false);
		assert.equal(counters.put, 1);
	}, {
		corruptPuts: 1,
		beforePut: ({ objects, index }) =>
		{
			if (index === 1)
			{
				objects.delete(FILE_ID);
			}
		},
	});
});

async function withRecoveryDir(fn)
{
	const dir = await mkdtemp(path.join(os.tmpdir(), "projecto-recovery-test-"));
	const previous = process.env.ARCHIVER_RECOVERY_DIR;

	process.env.ARCHIVER_RECOVERY_DIR = dir;

	try
	{
		await fn(dir);
	}
	finally
	{
		if (previous === undefined)
		{
			delete process.env.ARCHIVER_RECOVERY_DIR;
		}
		else
		{
			process.env.ARCHIVER_RECOVERY_DIR = previous;
		}

		await rm(dir, { recursive: true, force: true });
	}
}

test("the restore never overwrites a newer write and the original is kept for recovery", async () =>
{
	const data = compressibleData();
	const other = { body: Buffer.from("newer bytes"), contentType: "model/stl", metadata: {} };

	await withRecoveryDir(async (dir) =>
	{
		await withS3(async (s3, { objects, counters }) =>
		{
			seed(objects, data, { sha256: sha(data) });

			await assert.rejects(archiveOrderFile({ s3, fileId: FILE_ID }), ArchiveFileError);
			assert.equal(objects.get(FILE_ID), other);
			assert.equal(counters.put, 1);
			assert.equal(counters.rejected, 1);
			assert.ok((await readFile(path.join(dir, `${FILE_ID}.orig`))).equals(data));
		}, {
			corruptPuts: 1,
			beforePut: ({ objects, index }) =>
			{
				if (index === 1)
				{
					objects.set(FILE_ID, other);
				}
			},
		});
	});
});

test("when read-back and restore both fail the original is saved to the recovery directory", async () =>
{
	const data = compressibleData();
	const tempBefore = await archiverTempFiles();

	await withRecoveryDir(async (dir) =>
	{
		await withS3(async (s3, { objects }) =>
		{
			seed(objects, data, { sha256: sha(data) });

			await assert.rejects(
				archiveOrderFile({ s3, fileId: FILE_ID }),
				(err) => err instanceof ArchiveFileError && err.message.includes(path.join(dir, `${FILE_ID}.orig`)),
			);

			const saved = await readFile(path.join(dir, `${FILE_ID}.orig`));
			const info = JSON.parse(await readFile(path.join(dir, `${FILE_ID}.json`), "utf8"));

			assert.ok(saved.equals(data));
			assert.equal(info.fileId, FILE_ID);
			assert.equal(info.sha256, sha(data));
			assert.equal(info.size, data.length);
			assert.equal(info.contentType, "model/stl");
			assert.equal(info.metadata.original_name, encodeMetadataValue("Skan górny.stl"));
			assert.equal(info.metadata.compression, undefined);
		}, {
			corruptPuts: 1,
			beforePut: ({ index }) => (index === 1 ? 500 : undefined),
		});
	});

	assert.deepEqual(await archiverTempFiles(), tempBefore);
});

test("lib-storage passes IfMatch on to CompleteMultipartUpload", async () =>
{
	await withS3(async (s3, { objects, counters, requests }) =>
	{
		seed(objects, Buffer.from("current"));

		const before = objects.get(FILE_ID);
		const upload = new Upload({
			client: s3,
			params: { Bucket: BUCKET, Key: FILE_ID, Body: randomBytes(9 * 1024 * 1024), IfMatch: "\"stale\"" },
			queueSize: 1,
			partSize: 8 * 1024 * 1024,
		});

		await assert.rejects(upload.done(), (err) => err.name === "PreconditionFailed");

		const complete = requests.find((request) => request.method === "POST" && request.search.includes("uploadId"));

		assert.equal(complete.headers["if-match"], "\"stale\"");
		assert.equal(objects.get(FILE_ID), before);
		assert.equal(counters.put, 0);
	});
});

// ---- Job and lock ----

const hang = () => new Promise(() => undefined);

// postgres.js stand-in: tagged-template queries matched by their text.
// reservedHandler(text) answers queries on the reserved connection.
function fakeSql({ reservedHandler, reserve } = {})
{
	const released = { count: 0 };
	const reserved = (strings) => reservedHandler(strings.join("?"));

	reserved.release = () =>
	{
		released.count++;
	};

	const sql = (strings) =>
	{
		const text = strings.join("?");

		if (text.includes("SELECT order_id, files"))
		{
			return Promise.resolve([{ order_id: 7, files: [] }]);
		}

		if (text.includes("UPDATE orders"))
		{
			return Promise.resolve([{ order_id: 7 }]);
		}

		return Promise.resolve([]);
	};

	sql.reserve = reserve ?? (async () => reserved);

	return { sql, reserved, released };
}

function lockHandler({ confirm, unlock } = {})
{
	let lockCalls = 0;

	return (text) =>
	{
		if (text.includes("pg_try_advisory_lock"))
		{
			lockCalls++;

			if (lockCalls > 1 && confirm)
			{
				return confirm();
			}

			return Promise.resolve([{ pid: 42, locked: true }]);
		}

		if (text.includes("pg_advisory_unlock_all"))
		{
			return unlock ? unlock() : Promise.resolve([{}]);
		}

		return Promise.resolve([]);
	};
}

async function waitForJob()
{
	for (let i = 0; i < 200 && getArchiveJobStatus().state === "running"; i++)
	{
		await new Promise((resolve) => setTimeout(resolve, 10));
	}

	return getArchiveJobStatus();
}

test("a hung lock query fails the job instead of leaving it running", async () =>
{
	const { sql, released } = fakeSql({ reservedHandler: lockHandler({ confirm: hang, unlock: hang }) });
	const start = await startArchiveJob({ triggeredBy: "test", sql, s3: {}, dbTimeoutMs: 50 });

	assert.equal(start.started, true);

	const status = await waitForJob();

	assert.equal(status.state, "failed");
	assert.match(status.lastError, /timed out/);
	assert.ok(status.finishedAt);
	assert.equal(released.count, 1);

	// A new run can start right away.
	const healthy = fakeSql({ reservedHandler: lockHandler() });
	const again = await startArchiveJob({ triggeredBy: "test", sql: healthy.sql, s3: {}, dbTimeoutMs: 50 });

	assert.equal(again.started, true);

	const done = await waitForJob();

	assert.equal(done.state, "done");
	assert.equal(done.ordersArchived, 1);
	assert.equal(healthy.released.count, 1);
});

test("a reconnected lock session fails the job", async () =>
{
	const { sql, released } = fakeSql({
		reservedHandler: lockHandler({ confirm: async () => [{ pid: 43, locked: true }] }),
	});

	assert.equal((await startArchiveJob({ triggeredBy: "test", sql, s3: {}, dbTimeoutMs: 50 })).started, true);

	const status = await waitForJob();

	assert.equal(status.state, "failed");
	assert.match(status.lastError, /Lost the database session/);
	assert.equal(released.count, 1);
});

test("a connection that cannot be reserved in time does not block later starts", async () =>
{
	let lateReserved = null;
	const slow = fakeSql({
		reservedHandler: lockHandler(),
		reserve: () => new Promise((resolve) =>
		{
			setTimeout(() =>
			{
				lateReserved = slow.reserved;
				resolve(slow.reserved);
			}, 100);
		}),
	});

	await assert.rejects(
		startArchiveJob({ triggeredBy: "test", sql: slow.sql, s3: {}, dbTimeoutMs: 20 }),
		/timed out/,
	);

	// The connection that arrives late is handed back.
	await new Promise((resolve) => setTimeout(resolve, 150));
	assert.ok(lateReserved);
	assert.equal(slow.released.count, 1);

	const healthy = fakeSql({ reservedHandler: lockHandler() });

	assert.equal((await startArchiveJob({ triggeredBy: "test", sql: healthy.sql, s3: {}, dbTimeoutMs: 50 })).started, true);
	assert.equal((await waitForJob()).state, "done");
});
