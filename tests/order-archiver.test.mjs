import nodeTest from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { chmod, mkdtemp, readFile, readdir, readlink, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { buffer } from "node:stream/consumers";
import zlib from "node:zlib";
import { GetObjectCommand, HeadObjectCommand, PutObjectCommand, UploadPartCommand } from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import {
	ArchiveFileError,
	ChecksumMismatchError,
	FILE_OUTCOMES,
	ENCODER_META_KEY,
	archiveOrderFile as archiveOrderFileRaw,
	isFileOnOrder,
	markOrderArchived,
	recordFileResult,
} from "../src/app/server-functions/orders/orderArchiver.js";
import { DELETION_STALE_AFTER_MS, DELETION_STALE_INTERVAL } from "../src/app/server-functions/orders/orderRowLock.js";
import {
	createDecompressStream,
	createTempFilePath,
} from "../src/app/server-functions/orders/fileCompression.js";
import {
	FileBeingArchivedError,
	renameOrderFile,
	setOrderFileChecksum,
} from "../src/app/server-functions/orders/orderFiles.js";
import { deletePendingVerifyAttempt } from "../src/app/server-functions/orders/archiveJournal.js";
import { encodeMetadataValue } from "../src/app/server-functions/MinIO/metadataEncoding.js";
import { createFakeJournal } from "./helpers/fakeJournal.mjs";
import { withS3 } from "./helpers/s3Server.mjs";
import { TEST_ENCODER, testCompressor } from "./helpers/testCompressor.mjs";

// The archiver writes its temporary files to os.tmpdir(). Each test gets its
// own temporary directory instead (TMPDIR on POSIX, TEMP/TMP on Windows), so
// the leftover-file assertions only see this test's files and are not
// disturbed by other processes using the shared directory.
const TEMP_ENV_NAMES = ["TMPDIR", "TEMP", "TMP"];

async function withIsolatedTempDir(fn)
{
	const dir = await mkdtemp(path.join(os.tmpdir(), "projecto-archiver-test-"));
	const previous = TEMP_ENV_NAMES.map((name) => [name, process.env[name]]);

	for (const name of TEMP_ENV_NAMES)
	{
		process.env[name] = dir;
	}

	try
	{
		assert.equal(path.resolve(os.tmpdir()), path.resolve(dir), "os.tmpdir() does not follow the environment");
		await fn(dir);
	}
	finally
	{
		for (const [name, value] of previous)
		{
			if (value === undefined)
			{
				delete process.env[name];
			}
			else
			{
				process.env[name] = value;
			}
		}

		await rm(dir, { recursive: true, force: true });
	}
}

// Each test gets its own crash journal (archive_pending_verify).
const JOB_ID = "41";
let journal = null;

const test = (name, fn) => nodeTest(name, () => withIsolatedTempDir(() =>
{
	journal = createFakeJournal();
	return fn();
}));

const journalOptions = (timeoutMs = 1000) => ({ sql: journal.sql, jobId: JOB_ID, timeoutMs });

// archiveOrderFile with the test's journal. A file that settled (resolved, any
// outcome) never leaves its journal row behind.
async function archiveOrderFile(options)
{
	const result = await archiveOrderFileRaw({ journal: journalOptions(), ...options });

	assert.equal(journal.rows.has(options.fileId), false, `a ${result.outcome} file left its crash journal row`);

	return result;
}


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

		const result = await archiveOrderFile({ s3, fileId: FILE_ID, compress: testCompressor, now: () => NOW });
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
		const again = await archiveOrderFile({ s3, fileId: FILE_ID, compress: testCompressor });

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

		const result = await archiveOrderFile({ s3, fileId: FILE_ID, compress: testCompressor });

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

		const result = await archiveOrderFile({ s3, fileId: FILE_ID, compress: testCompressor, now: () => NOW });
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

		const again = await archiveOrderFile({ s3, fileId: FILE_ID, compress: testCompressor });

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

		await assert.rejects(archiveOrderFile({ s3, fileId: FILE_ID, compress: testCompressor }), (err) =>
		{
			assert.ok(err instanceof ChecksumMismatchError);
			assert.equal(err.expected, sha("something else"));
			assert.equal(err.actual, sha(data));
			assert.match(err.message, /expected sha256/);
			assert.deepEqual(err.files, [FILE_ID]);
			assert.equal(err.context, "stored sha256 vs. content; original left untouched");
			return true;
		});

		const after = objects.get(FILE_ID);

		assert.ok(after.body.equals(data));
		assert.deepEqual(after.metadata, before.metadata);
		assert.equal(counters.put, 0);
		assert.equal(counters.copy, 0);
	});

	assert.deepEqual(await archiverTempFiles(), tempBefore);
});

// A compressor whose output decompresses to different bytes of the same size.
function corruptingCompressor(data)
{
	return async () =>
	{
		const wrong = Buffer.from(data);

		wrong[0] ^= 0xff;

		const candidatePath = createTempFilePath(".zst");
		const compressed = zlib.zstdCompressSync(wrong);

		await writeFile(candidatePath, compressed);

		return { method: "zstd", path: candidatePath, size: compressed.length };
	};
}

test("a compressed result that does not round-trip is never uploaded", async () =>
{
	const data = compressibleData();
	const tempBefore = await archiverTempFiles();

	await withS3(async (s3, { objects, counters }) =>
	{
		seed(objects, data, { sha256: sha(data) });

		const before = structuredClone(objects.get(FILE_ID));
		const wrong = Buffer.from(data);

		wrong[0] ^= 0xff;

		await assert.rejects(
			archiveOrderFile({ s3, fileId: FILE_ID, compress: corruptingCompressor(data) }),
			(err) =>
			{
				assert.ok(err instanceof ChecksumMismatchError);
				assert.equal(err.expected, sha(data));
				assert.equal(err.actual, sha(wrong));
				assert.match(err.message, /round trip; original left untouched/);
				assert.deepEqual(err.files, [FILE_ID]);
				return true;
			},
		);

		const after = objects.get(FILE_ID);

		assert.ok(after.body.equals(data));
		assert.deepEqual(after.metadata, before.metadata);
		assert.equal(after.metadata.compression, undefined);
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

		await assert.rejects(
			archiveOrderFile({ s3, fileId: FILE_ID, compress: testCompressor }),
			(err) => err instanceof ArchiveFileError && /original restored/.test(err.message) && err.cause !== undefined,
		);

		const stored = objects.get(FILE_ID);

		assert.equal(counters.put, 2);
		assert.ok(stored.body.equals(data));
		assert.equal(stored.metadata.compression, undefined);
		// Restored: the journal row is closed and the original removed.
		assert.equal(journal.rows.size, 0);
		assert.deepEqual(journal.log, ["insert", "uploaded", "delete"]);
		assert.deepEqual(await archiverTempFiles(), []);
		assert.equal(stored.metadata.sha256, sha(data));
		assert.equal(stored.contentType, "model/stl");
	}, { corruptPuts: 1 });
});

test("a missing object is left for the next run instead of failing", async () =>
{
	await withS3(async (s3, { counters }) =>
	{
		const result = await archiveOrderFile({ s3, fileId: FILE_ID, compress: testCompressor });

		assert.equal(result.outcome, FILE_OUTCOMES.changed);
		assert.equal(result.originalSize, 0);
		assert.equal(counters.put, 0);
	});
});

// Makes every request of CommandClass fail with error (as the SDK would report it).
function failCommand(s3, CommandClass, error)
{
	const send = s3.send.bind(s3);

	s3.send = (command, options) =>
	{
		if (command instanceof CommandClass)
		{
			return Promise.reject(error);
		}

		return send(command, options);
	};
}

test("a HEAD that reports the file deleted is skipped, not failed, and leaves no temp files", async () =>
{
	const data = compressibleData();
	const tempBefore = await archiverTempFiles();

	await withS3(async (s3, { objects, counters }) =>
	{
		seed(objects, data, { sha256: sha(data) });
		failCommand(s3, HeadObjectCommand, Object.assign(new Error("Not Found"), { name: "NotFound" }));

		const result = await archiveOrderFile({ s3, fileId: FILE_ID, compress: testCompressor });

		assert.equal(result.outcome, FILE_OUTCOMES.changed);
		assert.equal(result.originalSize, 0);
		assert.equal(objects.has(FILE_ID), true);
		assert.equal(counters.put, 0);
		assert.deepEqual(await archiverTempFiles(), tempBefore);
	});
});

test("a GET that reports NoSuchKey is skipped, not failed, and leaves no temp files", async () =>
{
	const data = compressibleData();
	const tempBefore = await archiverTempFiles();

	await withS3(async (s3, { objects, counters }) =>
	{
		seed(objects, data, { sha256: sha(data) });
		failCommand(s3, GetObjectCommand, Object.assign(new Error("The specified key does not exist."), { name: "NoSuchKey" }));

		const result = await archiveOrderFile({ s3, fileId: FILE_ID, compress: testCompressor });

		assert.equal(result.outcome, FILE_OUTCOMES.changed);
		assert.equal(result.originalSize, 0);
		assert.equal(objects.has(FILE_ID), true);
		assert.equal(counters.put, 0);
		assert.deepEqual(await archiverTempFiles(), tempBefore);
	});
});

test("a HEAD failing with another error still fails the file", async () =>
{
	await withS3(async (s3) =>
	{
		failCommand(s3, HeadObjectCommand, Object.assign(new Error("Service unavailable"), { name: "ServiceUnavailable" }));

		await assert.rejects(archiveOrderFile({ s3, fileId: FILE_ID, compress: testCompressor }), { name: "ServiceUnavailable" });
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
			compress: testCompressor,
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

test("recordFileResult counts a failed file and keeps its error", () =>
{
	const status = { filesFailed: 0, filesCompressed: 0, lastError: null };
	const error = new ChecksumMismatchError([FILE_ID], { expected: sha("a"), actual: sha("b") });

	recordFileResult(status, { outcome: FILE_OUTCOMES.failed, error }, FILE_ID);

	assert.equal(status.filesFailed, 1);
	assert.equal(status.filesCompressed, 0);
	assert.equal(status.lastError, `File ${FILE_ID}: ${error.message}`);
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
		const renamed = await renameOrderFile(s3, FILE_ID, "Nowa nazwa.stl", { sql: journal.sql });
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
			renameOrderFile(s3, FILE_ID, "Nowa nazwa.stl", { sql: journal.sql }),
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

		const result = await archiveOrderFile({ s3, fileId: FILE_ID, compress: testCompressor });

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

		const result = await archiveOrderFile({ s3, fileId: FILE_ID, compress: testCompressor });

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
			compress: testCompressor,
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

		const result = await archiveOrderFile({ s3, fileId: FILE_ID, compress: testCompressor });

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

			await assert.rejects(archiveOrderFile({ s3, fileId: FILE_ID, compress: testCompressor }), ArchiveFileError);
			assert.equal(objects.get(FILE_ID), other);
			assert.equal(counters.put, 1);
			assert.equal(counters.rejected, 1);
			assert.ok((await readFile(path.join(dir, `${FILE_ID}.orig`))).equals(data));
			assert.equal(journal.rows.get(FILE_ID).state, "needs_attention");
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
				archiveOrderFile({ s3, fileId: FILE_ID, compress: testCompressor }),
				(err) => err instanceof ArchiveFileError && err.message.includes(path.join(dir, `${FILE_ID}.orig`)),
			);

			const saved = await readFile(path.join(dir, `${FILE_ID}.orig`));
			const info = JSON.parse(await readFile(path.join(dir, `${FILE_ID}.json`), "utf8"));

			assert.ok(saved.equals(data));
			// Patient data: owner-only copies.
			assert.equal((await stat(path.join(dir, `${FILE_ID}.orig`))).mode & 0o777, 0o600);
			assert.equal((await stat(path.join(dir, `${FILE_ID}.json`))).mode & 0o777, 0o600);
			assert.equal(info.fileId, FILE_ID);
			assert.equal(info.sha256, sha(data));
			assert.equal(info.size, data.length);
			assert.equal(info.contentType, "model/stl");
			assert.equal(info.metadata.original_name, encodeMetadataValue("Skan górny.stl"));
			assert.equal(info.metadata.compression, undefined);

			// 9.2 step 3: the row goes to an operator, with where the copy is.
			const row = journal.rows.get(FILE_ID);

			assert.equal(row.state, "needs_attention");
			assert.ok(row.note.includes(path.join(dir, `${FILE_ID}.orig`)));
			assert.ok(row.note.includes("restore:"));
		}, {
			corruptPuts: 1,
			beforePut: ({ index }) => (index === 1 ? 500 : undefined),
		});
	});

	// 9.2 step 4: the temp original stays while the row exists.
	const row = journal.rows.get(FILE_ID);
	const left = (await archiverTempFiles()).filter((name) => !tempBefore.includes(name));

	assert.deepEqual(left, [path.basename(row.original_path)]);
	assert.ok((await readFile(row.original_path)).equals(data));
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

test("compress is required and file ids must be UUIDs", async () =>
{
	await withS3(async (s3, { objects, counters }) =>
	{
		seed(objects, compressibleData());

		await assert.rejects(archiveOrderFile({ s3, fileId: FILE_ID }), TypeError);
		await assert.rejects(archiveOrderFileRaw({ s3, fileId: FILE_ID, compress: testCompressor }), TypeError);
		await assert.rejects(archiveOrderFileRaw({ s3, fileId: FILE_ID, compress: testCompressor, journal: { ...journalOptions(), jobId: null } }), TypeError);
		await assert.rejects(archiveOrderFileRaw({ s3, fileId: FILE_ID, compress: testCompressor, journal: { ...journalOptions(), timeoutMs: 0 } }), RangeError);
		await assert.rejects(archiveOrderFile({ s3, fileId: "../etc/passwd", compress: testCompressor }), TypeError);
		await assert.rejects(archiveOrderFile({ s3, fileId: FILE_ID.toUpperCase().slice(1), compress: testCompressor }), TypeError);
		assert.equal(counters.put, 0);
		assert.equal(counters.copy, 0);
	});

	assert.deepEqual(await archiverTempFiles(), []);
});

test("the encoder is stored as metadata, and a stale encoder key is never carried over", async () =>
{
	const data = compressibleData();

	await withS3(async (s3, { objects }) =>
	{
		seed(objects, data, { [ENCODER_META_KEY]: "old-encoder" });

		await archiveOrderFile({ s3, fileId: FILE_ID, compress: testCompressor });
		assert.equal(objects.get(FILE_ID).metadata[ENCODER_META_KEY], TEST_ENCODER);
	});

	// A compressor that reports no (or an unusable) encoder: no key at all.
	for (const encoder of [undefined, null, "bad\nvalue", "x".repeat(201)])
	{
		await withS3(async (s3, { objects }) =>
		{
			seed(objects, data, { [ENCODER_META_KEY]: "old-encoder" });

			const compress = async (srcPath, options) => ({ ...(await testCompressor(srcPath, options)), encoder });
			const result = await archiveOrderFile({ s3, fileId: FILE_ID, compress });

			assert.equal(result.outcome, FILE_OUTCOMES.compressed);
			assert.equal(objects.get(FILE_ID).metadata[ENCODER_META_KEY], undefined);
		});
	}
});

test("onProgress reports each phase without file ids, and a throwing listener is ignored", async () =>
{
	const data = compressibleData();

	await withS3(async (s3, { objects }) =>
	{
		seed(objects, data);

		const events = [];
		const result = await archiveOrderFile({
			s3,
			fileId: FILE_ID,
			compress: testCompressor,
			onProgress: (progress) =>
			{
				events.push(progress);
				throw new Error("listener failure");
			},
		});

		assert.equal(result.outcome, FILE_OUTCOMES.compressed);

		const phases = [...new Set(events.map((event) => event.phase))];

		assert.deepEqual(phases, ["download", "compress-zstd", "verify", "upload", "readback"]);
		assert.ok(events.every((event) => Object.keys(event).join() === "phase,bytesDone,bytesTotal"));
		assert.equal(events.filter((event) => event.phase === "download").at(-1).bytesDone, data.length);
		assert.deepEqual(events.find((event) => event.phase === "readback"), { phase: "readback", bytesDone: 0, bytesTotal: result.storedSize });
	});
});

// ---- crash journal around the replacing upload (phase4.md 9.2) ----

test("the journal row is written before the upload and cleared after a passing read-back", async () =>
{
	const data = compressibleData();
	let rowDuringUpload = null;

	await withS3(async (s3, { objects }) =>
	{
		seed(objects, data, { sha256: sha(data) });

		const preUploadEtag = `"${createHash("md5").update(data).digest("hex")}"`;
		const result = await archiveOrderFile({ s3, fileId: FILE_ID, compress: testCompressor });

		assert.equal(result.outcome, FILE_OUTCOMES.compressed);
		assert.deepEqual(journal.log, ["insert", "uploaded", "delete"]);
		assert.equal(rowDuringUpload.state, "uploading");
		assert.equal(rowDuringUpload.job_id, JOB_ID);
		assert.equal(rowDuringUpload.method, "zstd");
		assert.equal(rowDuringUpload.original_sha256, sha(data));
		assert.equal(rowDuringUpload.original_size, String(data.length));
		assert.equal(rowDuringUpload.stored_size, String(result.storedSize));
		assert.equal(rowDuringUpload.pre_upload_etag, preUploadEtag);
		assert.equal(rowDuringUpload.stored_etag, null);
		assert.ok(path.basename(rowDuringUpload.original_path).startsWith("projecto-archive-"));
		assert.deepEqual(await archiverTempFiles(), []);
	}, {
		beforePut: ({ key }) =>
		{
			rowDuringUpload = { ...journal.rows.get(key) };
		},
	});
});

test("a journal insert that fails fails the file and nothing is uploaded", async () =>
{
	const data = compressibleData();

	await withS3(async (s3, { objects, counters }) =>
	{
		seed(objects, data, { sha256: sha(data) });
		journal.failures.insert = 1;

		await assert.rejects(
			archiveOrderFile({ s3, fileId: FILE_ID, compress: testCompressor }),
			(err) => err instanceof ArchiveFileError && /crash journal/.test(err.message),
		);
		assert.equal(counters.put, 0);
		assert.ok(objects.get(FILE_ID).body.equals(data));
		assert.equal(journal.rows.size, 0);
		assert.deepEqual(await archiverTempFiles(), []);
	});
});

test("a file that already has a journal row is never replaced again", async () =>
{
	const data = compressibleData();

	await withS3(async (s3, { objects, counters }) =>
	{
		seed(objects, data, { sha256: sha(data) });
		journal.seed({
			file_id: FILE_ID,
			state: "needs_attention",
			original_sha256: sha(data),
			original_size: data.length,
			stored_size: 1,
			pre_upload_etag: "\"x\"",
			original_path: path.join(os.tmpdir(), "projecto-archive-kept"),
		});

		await assert.rejects(archiveOrderFile({ s3, fileId: FILE_ID, compress: testCompressor }), ArchiveFileError);
		assert.equal(counters.put, 0);
		assert.equal(journal.rows.get(FILE_ID).state, "needs_attention");
	});
});

test("journal statements are bounded: a hung insert fails the file before any upload", async () =>
{
	const data = compressibleData();

	await withS3(async (s3, { objects, counters }) =>
	{
		seed(objects, data, { sha256: sha(data) });
		journal.hangs.add("insert");

		await assert.rejects(
			archiveOrderFileRaw({ s3, fileId: FILE_ID, compress: testCompressor, journal: journalOptions(30) }),
			/timed out after 30 ms/,
		);
		assert.equal(counters.put, 0);
		assert.deepEqual(await archiverTempFiles(), []);
	});
});

test("a refused upload (412) deletes the journal row", async () =>
{
	const data = compressibleData();

	await withS3(async (s3, { objects }) =>
	{
		seed(objects, data, { sha256: sha(data) });

		const result = await archiveOrderFile({ s3, fileId: FILE_ID, compress: testCompressor });

		assert.equal(result.outcome, FILE_OUTCOMES.changed);
		assert.deepEqual(journal.log, ["insert", "delete"]);
		assert.deepEqual(await archiverTempFiles(), []);
	}, {
		beforePut: ({ objects }) =>
		{
			objects.set(FILE_ID, { body: Buffer.from("newer"), contentType: "model/stl", metadata: {} });
		},
	});
});

test("any other upload error keeps the journal row and the original on disk", async () =>
{
	const data = compressibleData();

	await withS3(async (s3, { objects }) =>
	{
		seed(objects, data, { sha256: sha(data) });

		await assert.rejects(archiveOrderFile({ s3, fileId: FILE_ID, compress: testCompressor }), { name: "InternalError" });

		const row = journal.rows.get(FILE_ID);

		assert.equal(row.state, "uploading");
		assert.deepEqual(journal.log, ["insert"]);
		// The finally rule: the original stays while a row exists; the
		// compressed candidate does not.
		assert.deepEqual(await archiverTempFiles(), [path.basename(row.original_path)]);
		assert.ok((await readFile(row.original_path)).equals(data));
	}, {
		beforePut: () => 500,
	});
});

test("a failed read-back of an object deleted meanwhile clears the journal row", async () =>
{
	const data = compressibleData();

	await withS3(async (s3, { objects }) =>
	{
		seed(objects, data, { sha256: sha(data) });

		const result = await archiveOrderFile({ s3, fileId: FILE_ID, compress: testCompressor });

		assert.equal(result.outcome, FILE_OUTCOMES.changed);
		assert.deepEqual(journal.log, ["insert", "uploaded", "delete"]);
		assert.deepEqual(await archiverTempFiles(), []);
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

test("an orphan deleted after the read-back clears the journal row", async () =>
{
	const data = compressibleData();

	for (const corruptPuts of [0, 1])
	{
		journal = createFakeJournal();

		await withS3(async (s3, { objects }) =>
		{
			seed(objects, data, { sha256: sha(data) });

			const result = await archiveOrderFile({
				s3,
				fileId: FILE_ID,
				compress: testCompressor,
				isStillAttached: async () => false,
			});

			assert.equal(result.outcome, FILE_OUTCOMES.orphaned);
			assert.equal(objects.has(FILE_ID), false);
			assert.deepEqual(journal.log, ["insert", "uploaded", "delete"]);
			assert.deepEqual(await archiverTempFiles(), []);
		}, { corruptPuts });
	}
});

test("a verified archive whose journal row cannot be cleared fails the file and keeps the original", async () =>
{
	const data = compressibleData();

	await withS3(async (s3, { objects }) =>
	{
		seed(objects, data, { sha256: sha(data) });
		journal.failures.delete = 1;

		await assert.rejects(
			archiveOrderFile({ s3, fileId: FILE_ID, compress: testCompressor }),
			(err) => err instanceof ArchiveFileError && /journal row could not be cleared/.test(err.message),
		);

		const row = journal.rows.get(FILE_ID);

		assert.equal(row.state, "uploaded");
		assert.equal(row.stored_etag, `"${createHash("md5").update(objects.get(FILE_ID).body).digest("hex")}"`);
		assert.deepEqual(await archiverTempFiles(), [path.basename(row.original_path)]);
	});
});

test("a failing 'uploaded' update does not fail the file", async () =>
{
	const data = compressibleData();

	await withS3(async (s3, { objects }) =>
	{
		seed(objects, data, { sha256: sha(data) });
		journal.failures.uploaded = 1;

		const result = await archiveOrderFile({ s3, fileId: FILE_ID, compress: testCompressor });

		assert.equal(result.outcome, FILE_OUTCOMES.compressed);
		assert.deepEqual(await archiverTempFiles(), []);
	});
});

// ---- review 2026-11-20: items 2, 19 to 22 and 25 ----

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Passes every request on to the real client; intercept(command, send) can
// answer the ones it wants to change.
function interceptSend(s3, intercept)
{
	const send = s3.send.bind(s3);

	s3.send = (command, options) => intercept(command, () => send(command, options));
}

const serviceUnavailable = () => Object.assign(new Error("ServiceUnavailable"), {
	name: "ServiceUnavailable",
	$metadata: { httpStatusCode: 503 },
});

test("the downloaded original is created owner-only", async () =>
{
	const data = compressibleData();
	const modes = [];

	await withS3(async (s3, { objects }) =>
	{
		seed(objects, data, { sha256: sha(data) });

		const result = await archiveOrderFile({
			s3,
			fileId: FILE_ID,
			compress: async (srcPath, options) =>
			{
				modes.push((await stat(srcPath)).mode & 0o777);
				return testCompressor(srcPath, options);
			},
		});

		assert.equal(result.outcome, FILE_OUTCOMES.compressed);
		assert.deepEqual(modes, [0o600]);
	});
});

test("bytes replaced by others of the same size during compression are not archived (no sha256 to tell)", async () =>
{
	const data = compressibleData();
	const newer = Buffer.from(data);

	newer[10] ^= 0xff;

	await withS3(async (s3, { objects, counters }) =>
	{
		// An older upload without sha256 metadata.
		seed(objects, data);

		const result = await archiveOrderFile({
			s3,
			fileId: FILE_ID,
			compress: async (srcPath, options) =>
			{
				objects.set(FILE_ID, { ...objects.get(FILE_ID), body: newer });
				return testCompressor(srcPath, options);
			},
		});

		// The HEAD's ETag no longer names the downloaded bytes.
		assert.equal(result.outcome, FILE_OUTCOMES.changed);
		assert.equal(counters.put, 0);
		assert.ok(objects.get(FILE_ID).body.equals(newer));
		assert.deepEqual(journal.log, []);
	});
});

test("a journal insert that lands after its timeout is removed again", async () =>
{
	const data = compressibleData();

	await withS3(async (s3, { objects, counters }) =>
	{
		seed(objects, data, { sha256: sha(data) });

		const sql = (strings, ...values) =>
		{
			if (strings.join("?").includes("INSERT INTO archive_pending_verify"))
			{
				return delay(80).then(() => journal.sql(strings, ...values));
			}

			return journal.sql(strings, ...values);
		};

		await assert.rejects(
			archiveOrderFileRaw({ s3, fileId: FILE_ID, compress: testCompressor, journal: { sql, jobId: JOB_ID, timeoutMs: 30 } }),
			/timed out after 30 ms/,
		);

		await delay(150);

		assert.equal(counters.put, 0);
		assert.deepEqual(journal.log, ["insert", "delete"]);
		assert.equal(journal.rows.has(FILE_ID), false);
		assert.deepEqual(await archiverTempFiles(), []);
	});
});

test("the late-insert cleanup only removes the row of its own attempt while it is 'uploading'", async () =>
{
	const row = {
		file_id: FILE_ID,
		original_sha256: "a".repeat(64),
		original_size: 10,
		stored_size: 5,
		pre_upload_etag: "\"etag\"",
		original_path: "/work/tmp/projecto-archive-00000000-0000-4000-8000-000000000001",
	};

	journal.seed(row);
	await deletePendingVerifyAttempt(journal.sql, FILE_ID, "/work/tmp/projecto-archive-00000000-0000-4000-8000-000000000002");
	assert.equal(journal.rows.has(FILE_ID), true);

	journal.seed({ ...row, state: "uploaded" });
	await deletePendingVerifyAttempt(journal.sql, FILE_ID, row.original_path);
	assert.equal(journal.rows.has(FILE_ID), true);

	journal.seed(row);
	await deletePendingVerifyAttempt(journal.sql, FILE_ID, row.original_path);
	assert.equal(journal.rows.has(FILE_ID), false);
});

// Strips the ETag from PutObject answers, like an S3 that returns none, and
// calls afterPut once each PUT has landed.
function dropPutEtags(s3, afterPut)
{
	interceptSend(s3, async (command, send) =>
	{
		if (!(command instanceof PutObjectCommand))
		{
			return send();
		}

		const response = await send();

		afterPut?.();

		return { ...response, ETag: undefined };
	});
}

test("a restore after an upload that returned no ETag is bound to our archive's current ETag", async () =>
{
	const data = compressibleData();

	await withS3(async (s3, { objects, counters }) =>
	{
		seed(objects, data, { sha256: sha(data) });
		dropPutEtags(s3);

		await assert.rejects(
			archiveOrderFile({ s3, fileId: FILE_ID, compress: testCompressor }),
			(err) => err instanceof ArchiveFileError && /original restored/.test(err.message),
		);

		assert.equal(counters.put, 2);
		assert.ok(objects.get(FILE_ID).body.equals(data));
		assert.equal(objects.get(FILE_ID).metadata.compression, undefined);
	}, { corruptPuts: 1 });
});

test("without an upload ETag, a newer write after our upload is never overwritten by a restore", async () =>
{
	const data = compressibleData();
	const other = { body: Buffer.from("newer bytes"), contentType: "model/stl", metadata: {} };

	await withS3(async (s3, { objects, counters }) =>
	{
		seed(objects, data, { sha256: sha(data) });
		dropPutEtags(s3, () =>
		{
			objects.set(FILE_ID, other);
		});

		const result = await archiveOrderFile({ s3, fileId: FILE_ID, compress: testCompressor });

		assert.equal(result.outcome, FILE_OUTCOMES.changed);
		assert.equal(counters.put, 1);
		assert.equal(objects.get(FILE_ID), other);
		assert.deepEqual(await archiverTempFiles(), []);
	});
});

test("an error checking the order after a passing read-back keeps the verified archive", async () =>
{
	const data = compressibleData();

	await withS3(async (s3, { objects }) =>
	{
		seed(objects, data, { sha256: sha(data) });

		const result = await archiveOrderFile({
			s3,
			fileId: FILE_ID,
			compress: testCompressor,
			isStillAttached: async () =>
			{
				throw new Error("connection reset");
			},
		});

		assert.equal(result.outcome, FILE_OUTCOMES.compressed);
		assert.equal(objects.get(FILE_ID).metadata.compression, "zstd");
		assert.deepEqual(journal.log, ["insert", "uploaded", "delete"]);
		assert.deepEqual(await archiverTempFiles(), []);
	});
});

test("a read-back that cannot read the object restores nothing and leaves the row for recovery", async () =>
{
	const data = compressibleData();

	await withS3(async (s3, { objects, counters }) =>
	{
		seed(objects, data, { sha256: sha(data) });

		let gets = 0;

		interceptSend(s3, (command, send) =>
		{
			// The first GET is the download; every read-back GET fails.
			if (command instanceof GetObjectCommand && gets++ > 0)
			{
				return Promise.reject(serviceUnavailable());
			}

			return send();
		});

		await assert.rejects(
			archiveOrderFileRaw({ s3, fileId: FILE_ID, compress: testCompressor, journal: journalOptions() }),
			(err) => err instanceof ArchiveFileError && /Could not read the stored object back/.test(err.message),
		);

		const row = journal.rows.get(FILE_ID);

		assert.equal(gets, 3);
		assert.equal(counters.put, 1);
		assert.equal(objects.get(FILE_ID).metadata.compression, "zstd");
		assert.equal(row.state, "uploaded");
		assert.deepEqual(await archiverTempFiles(), [path.basename(row.original_path)]);
		assert.ok((await readFile(row.original_path)).equals(data));
	});
});

test("a read-back that fails once with a network error is retried", async () =>
{
	const data = compressibleData();

	await withS3(async (s3, { objects, counters }) =>
	{
		seed(objects, data, { sha256: sha(data) });

		let gets = 0;

		interceptSend(s3, (command, send) =>
		{
			if (command instanceof GetObjectCommand && gets++ === 1)
			{
				return Promise.reject(Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }));
			}

			return send();
		});

		const result = await archiveOrderFile({ s3, fileId: FILE_ID, compress: testCompressor });

		assert.equal(result.outcome, FILE_OUTCOMES.compressed);
		assert.equal(counters.put, 1);
		assert.deepEqual(await archiverTempFiles(), []);
	});
});

// ---- review 2026-11-20 (second pass): identity ETag binding, read-back
// classification, recovery directory modes, ETag-less paths, upload stream ----

test("identity path: bytes replaced during compression get no metadata write", async () =>
{
	const data = randomBytes(32 * 1024);
	const newer = randomBytes(data.length);

	await withS3(async (s3, { objects, counters }) =>
	{
		// No stored sha256, so only the ETag can tell the versions apart.
		seed(objects, data);

		const result = await archiveOrderFile({
			s3,
			fileId: FILE_ID,
			compress: async (srcPath, options) =>
			{
				objects.set(FILE_ID, { ...objects.get(FILE_ID), body: newer });
				return testCompressor(srcPath, options);
			},
		});
		const stored = objects.get(FILE_ID);

		assert.equal(result.outcome, FILE_OUTCOMES.changed);
		assert.equal(counters.copyAttempts, 0);
		assert.equal(counters.copy, 0);
		assert.equal(counters.put, 0);
		assert.ok(stored.body.equals(newer));
		assert.equal(stored.metadata.compression, undefined);
		assert.equal(stored.metadata.sha256, undefined);
		assert.deepEqual(await archiverTempFiles(), []);
	});
});

test("identity path: bytes replaced between the metadata HEAD and its copy get no metadata write", async () =>
{
	const data = randomBytes(32 * 1024);
	const newer = randomBytes(data.length);

	await withS3(async (s3, { objects, counters }) =>
	{
		seed(objects, data);

		const result = await archiveOrderFile({ s3, fileId: FILE_ID, compress: testCompressor });
		const stored = objects.get(FILE_ID);

		// The copy is refused (412) and the retry's HEAD shows another ETag.
		assert.equal(result.outcome, FILE_OUTCOMES.changed);
		assert.equal(counters.copyAttempts, 1);
		assert.equal(counters.rejected, 1);
		assert.equal(counters.copy, 0);
		assert.ok(stored.body.equals(newer));
		assert.equal(stored.metadata.compression, undefined);
		assert.equal(stored.metadata.sha256, undefined);
	}, {
		beforeCopy: ({ objects, index }) =>
		{
			if (index === 0)
			{
				objects.set(FILE_ID, { ...objects.get(FILE_ID), body: newer });
			}
		},
	});
});

test("a GET without an ETag fails the file and leaves the original untouched", async () =>
{
	const data = compressibleData();

	await withS3(async (s3, { objects, counters }) =>
	{
		seed(objects, data, { sha256: sha(data) });

		const before = structuredClone(objects.get(FILE_ID));
		let compressed = 0;

		interceptSend(s3, async (command, send) =>
		{
			const response = await send();

			return command instanceof GetObjectCommand ? { ...response, ETag: undefined } : response;
		});

		await assert.rejects(
			archiveOrderFile({
				s3,
				fileId: FILE_ID,
				compress: async (srcPath, options) =>
				{
					compressed++;
					return testCompressor(srcPath, options);
				},
			}),
			(err) => err instanceof ArchiveFileError && /returned no ETag; original left untouched/.test(err.message),
		);

		const after = objects.get(FILE_ID);

		assert.equal(compressed, 0);
		assert.ok(after.body.equals(data));
		assert.deepEqual(after.metadata, before.metadata);
		assert.equal(counters.put + counters.copy + counters.delete, 0);
		assert.deepEqual(journal.log, []);
		assert.deepEqual(await archiverTempFiles(), []);
	});
});

// The archiver's HEADs: #1 before the download, #2 before the journal insert,
// #3 right before the upload (its metadata is the one written), #4 the one
// findOwnArchive takes when the upload returned no ETag. onOwnArchiveHead
// answers #4 (or calls send for it).
function interceptOwnArchiveHead(s3, onOwnArchiveHead)
{
	let heads = 0;

	interceptSend(s3, (command, send) =>
	{
		if (command instanceof HeadObjectCommand && ++heads === 4)
		{
			return onOwnArchiveHead(send);
		}

		return send();
	});
}

test("findOwnArchive: an object deleted before the restore has nothing to restore", async () =>
{
	const data = compressibleData();

	await withS3(async (s3, { objects, counters }) =>
	{
		seed(objects, data, { sha256: sha(data) });
		dropPutEtags(s3);
		interceptOwnArchiveHead(s3, (send) =>
		{
			objects.delete(FILE_ID);
			return send();
		});

		const result = await archiveOrderFile({ s3, fileId: FILE_ID, compress: testCompressor });

		assert.equal(result.outcome, FILE_OUTCOMES.changed);
		assert.equal(counters.put, 1);
		assert.equal(objects.has(FILE_ID), false);
		assert.deepEqual(await archiverTempFiles(), []);
	}, { corruptPuts: 1 });
});

for (const [name, answer, pattern] of [
	["a HEAD that fails", () => Promise.reject(serviceUnavailable()), /ServiceUnavailable/],
	["a HEAD without an ETag", async (send) => ({ ...(await send()), ETag: undefined }), /Neither the upload nor a HEAD returned an ETag/],
])
{
	test(`findOwnArchive: ${name} restores nothing and saves the original for recovery`, async () =>
	{
		const data = compressibleData();

		await withRecoveryDir(async (dir) =>
		{
			await withS3(async (s3, { objects, counters }) =>
			{
				seed(objects, data, { sha256: sha(data) });
				dropPutEtags(s3);
				interceptOwnArchiveHead(s3, answer);

				await assert.rejects(
					archiveOrderFileRaw({ s3, fileId: FILE_ID, compress: testCompressor, journal: journalOptions() }),
					(err) => err instanceof ArchiveFileError && /Read-back verification and restore failed/.test(err.message),
				);

				const row = journal.rows.get(FILE_ID);

				// Our (corrupt) archive stays; nothing was written over it.
				assert.equal(counters.put, 1);
				assert.equal(objects.get(FILE_ID).metadata.compression, "zstd");
				assert.equal(row.state, "needs_attention");
				assert.match(row.note, pattern);
				assert.ok((await readFile(path.join(dir, `${FILE_ID}.orig`))).equals(data));
				assert.ok((await readFile(row.original_path)).equals(data));
			}, { corruptPuts: 1 });
		});
	});
}

test("an existing recovery directory and earlier copies are made owner-only", async () =>
{
	const data = compressibleData();

	await withRecoveryDir(async (dir) =>
	{
		const origPath = path.join(dir, `${FILE_ID}.orig`);
		const infoPath = path.join(dir, `${FILE_ID}.json`);

		// Left by an operator or an earlier save with looser modes.
		await chmod(dir, 0o755);
		await writeFile(origPath, "earlier copy");
		await writeFile(infoPath, "{}");
		await chmod(origPath, 0o644);
		await chmod(infoPath, 0o644);

		await withS3(async (s3, { objects }) =>
		{
			seed(objects, data, { sha256: sha(data) });

			await assert.rejects(archiveOrderFile({ s3, fileId: FILE_ID, compress: testCompressor }), ArchiveFileError);
		}, {
			corruptPuts: 1,
			beforePut: ({ index }) => (index === 1 ? 500 : undefined),
		});

		assert.equal((await stat(dir)).mode & 0o777, 0o700);
		assert.equal((await stat(origPath)).mode & 0o777, 0o600);
		assert.equal((await stat(infoPath)).mode & 0o777, 0o600);
		assert.ok((await readFile(origPath)).equals(data));
		assert.equal(JSON.parse(await readFile(infoPath, "utf8")).sha256, sha(data));
	});
});

test("a read-back failing with an S3 RequestTimeout or a retryable SDK error is retried", async () =>
{
	const errors = [
		// S3 answers RequestTimeout with a 400.
		() => Object.assign(new Error("Your socket connection to the server was not read from or written to within the timeout period."), {
			name: "RequestTimeout",
			$metadata: { httpStatusCode: 400 },
		}),
		() => Object.assign(new Error("Reduce your request rate."), {
			name: "SlowDown",
			$retryable: { throttling: true },
			$metadata: { httpStatusCode: 400 },
		}),
	];

	for (const makeError of errors)
	{
		journal = createFakeJournal();

		await withS3(async (s3, { objects, counters }) =>
		{
			const data = compressibleData();

			seed(objects, data, { sha256: sha(data) });

			let gets = 0;

			interceptSend(s3, (command, send) =>
			{
				if (command instanceof GetObjectCommand && gets++ === 1)
				{
					return Promise.reject(makeError());
				}

				return send();
			});

			const result = await archiveOrderFile({ s3, fileId: FILE_ID, compress: testCompressor });

			assert.equal(result.outcome, FILE_OUTCOMES.compressed);
			assert.equal(gets, 3);
			assert.equal(counters.put, 1);
		});
	}
});

test("a read-back source that closes early (premature close) is retried, not judged", async () =>
{
	const data = compressibleData();

	await withS3(async (s3, { objects, counters }) =>
	{
		seed(objects, data, { sha256: sha(data) });

		let gets = 0;

		interceptSend(s3, async (command, send) =>
		{
			const response = await send();

			if (!(command instanceof GetObjectCommand) || gets++ !== 1)
			{
				return response;
			}

			// The connection drops halfway through the stored archive.
			const bytes = await buffer(response.Body);
			const body = new Readable({ read() 
			{} });

			body.push(bytes.subarray(0, Math.floor(bytes.length / 2)));
			setImmediate(() => body.destroy(Object.assign(new Error("Premature close"), { code: "ERR_STREAM_PREMATURE_CLOSE" })));

			return { ...response, Body: body };
		});

		const result = await archiveOrderFile({ s3, fileId: FILE_ID, compress: testCompressor });

		assert.equal(result.outcome, FILE_OUTCOMES.compressed);
		assert.equal(gets, 3);
		assert.equal(counters.put, 1);
	});
});

test("a stored archive the decoder rejects is a decode failure, never a transient read error", async () =>
{
	const data = compressibleData();

	await withS3(async (s3, { objects, counters }) =>
	{
		seed(objects, data, { sha256: sha(data) });

		let gets = 0;

		interceptSend(s3, (command, send) =>
		{
			if (command instanceof GetObjectCommand)
			{
				gets++;
			}

			return send();
		});

		// The stored frame's last byte is flipped: the decoder's checksum fails.
		await assert.rejects(
			archiveOrderFile({ s3, fileId: FILE_ID, compress: testCompressor }),
			(err) => err instanceof ArchiveFileError && /original restored/.test(err.message) &&
				err.cause?.name === "StoredArchiveDecodeError" && err.cause instanceof ArchiveFileError,
		);

		// One download and one read-back: no retry, then the restore.
		assert.equal(gets, 2);
		assert.equal(counters.put, 2);
		assert.ok(objects.get(FILE_ID).body.equals(data));
	}, { corruptPuts: 1 });
});

// File descriptors this process holds on archiver temp files (Linux only).
async function openTempDescriptors()
{
	const fds = await readdir("/proc/self/fd").catch(() => null);

	if (!fds)
	{
		return null;
	}

	const targets = await Promise.all(fds.map((fd) => readlink(path.join("/proc/self/fd", fd)).catch(() => "")));

	return targets.filter((target) => path.basename(target).startsWith("projecto-archive-"));
}

test("a failed multipart upload closes the candidate's read stream", async () =>
{
	if ((await openTempDescriptors()) === null)
	{
		return;
	}

	const data = randomBytes(9 * 1024 * 1024);

	await withS3(async (s3, { objects, counters }) =>
	{
		seed(objects, data, { sha256: sha(data) });

		let duringUpload = null;

		interceptSend(s3, async (command, send) =>
		{
			if (command instanceof UploadPartCommand)
			{
				duringUpload ??= await openTempDescriptors();
				throw serviceUnavailable();
			}

			return send();
		});

		// Incompressible, but archived anyway so the candidate needs two parts.
		const compress = async (srcPath) =>
		{
			const output = zlib.zstdCompressSync(await readFile(srcPath));
			const candidatePath = createTempFilePath(".zst");

			await writeFile(candidatePath, output);

			return { method: "zstd", path: candidatePath, size: output.length };
		};

		await assert.rejects(
			archiveOrderFileRaw({ s3, fileId: FILE_ID, compress, journal: journalOptions() }),
			/ServiceUnavailable/,
		);
		await delay(50);

		// The probe sees the candidate's stream while the upload runs, and
		// nothing once the failed upload has returned.
		assert.equal(duringUpload.filter((target) => target.includes(".zst")).length, 1);
		assert.equal(counters.put, 0);
		assert.ok(objects.get(FILE_ID).body.equals(data));
		assert.deepEqual((await openTempDescriptors()).filter((target) => target.includes(".zst")), []);
	});
});

// ---- review 2026-11-20, item 3: renames during an archive upload ----

const NEW_NAME = "Nowa nazwa.stl";

// A crash journal row for FILE_ID, as archiveOrderFile writes it before the upload.
function seedJournalRow(data)
{
	journal.seed({
		file_id: FILE_ID,
		original_path: path.join(os.tmpdir(), "projecto-archive-00000000-0000-4000-8000-000000000000"),
		original_sha256: sha(data),
		original_size: data.length,
		stored_size: 10,
		pre_upload_etag: "\"etag\"",
	});
}

test("renameOrderFile refuses while the file has a journal row, and goes through once it is gone", async () =>
{
	const data = compressibleData();

	await withS3(async (s3, { objects, counters }) =>
	{
		seed(objects, data);
		seedJournalRow(data);

		await assert.rejects(
			renameOrderFile(s3, FILE_ID, NEW_NAME, { sql: journal.sql }),
			(err) => err instanceof FileBeingArchivedError && err.fileIds.includes(FILE_ID),
		);
		assert.equal(counters.copyAttempts, 0);
		assert.equal(objects.get(FILE_ID).metadata.original_name, encodeMetadataValue("Skan górny.stl"));

		journal.rows.delete(FILE_ID);

		assert.equal(await renameOrderFile(s3, FILE_ID, NEW_NAME, { sql: journal.sql }), true);
		assert.equal(objects.get(FILE_ID).metadata.original_name, encodeMetadataValue(NEW_NAME));
	});
});

test("renameOrderFile to the current name neither checks the journal nor copies", async () =>
{
	const data = compressibleData();

	await withS3(async (s3, { objects, counters }) =>
	{
		seed(objects, data);
		seedJournalRow(data);

		assert.equal(await renameOrderFile(s3, FILE_ID, "Skan górny.stl", { sql: journal.sql }), false);
		assert.equal(counters.copyAttempts, 0);
		assert.deepEqual(journal.log, []);
	});
});

test("renameOrderFile needs a journal client", async () =>
{
	await withS3(async (s3) =>
	{
		await assert.rejects(renameOrderFile(s3, FILE_ID, NEW_NAME), TypeError);
	});
});

test("a rename that lands after the pre-insert HEAD is in the archive: its metadata is read again after the insert", async () =>
{
	const data = compressibleData();
	let heads = 0;

	await withS3(async (s3, { objects }) =>
	{
		seed(objects, data, { sha256: sha(data) });
		interceptSend(s3, async (command, send) =>
		{
			const response = await send();

			// A metadata-only rename (same ETag) right after HEAD #2, before the
			// journal row exists, so renameOrderFile could not refuse it.
			if (command instanceof HeadObjectCommand && ++heads === 2)
			{
				objects.get(FILE_ID).metadata.original_name = encodeMetadataValue(NEW_NAME);
			}

			return response;
		});

		const result = await archiveOrderFile({ s3, fileId: FILE_ID, compress: testCompressor });
		const stored = objects.get(FILE_ID);

		assert.equal(result.outcome, FILE_OUTCOMES.compressed);
		assert.equal(stored.metadata.compression, result.method);
		assert.equal(stored.metadata.original_name, encodeMetadataValue(NEW_NAME));
	});
});

test("a rename during the upload is refused; the archive keeps the name, and the rename works afterwards", async () =>
{
	const data = compressibleData();
	let refused = null;

	await withS3(async (s3, { objects }) =>
	{
		seed(objects, data, { sha256: sha(data) });
		interceptSend(s3, async (command, send) =>
		{
			if (command instanceof PutObjectCommand && refused === null)
			{
				refused = await renameOrderFile(s3, FILE_ID, NEW_NAME, { sql: journal.sql }).then(
					() => false,
					(err) => err instanceof FileBeingArchivedError,
				);
			}

			return send();
		});

		const result = await archiveOrderFile({ s3, fileId: FILE_ID, compress: testCompressor });

		assert.equal(result.outcome, FILE_OUTCOMES.compressed);
		assert.equal(refused, true);
		assert.equal(objects.get(FILE_ID).metadata.original_name, encodeMetadataValue("Skan górny.stl"));

		// The row is closed now; the user's retry goes through and keeps the archive marker.
		assert.equal(await renameOrderFile(s3, FILE_ID, NEW_NAME, { sql: journal.sql }), true);
		assert.equal(objects.get(FILE_ID).metadata.original_name, encodeMetadataValue(NEW_NAME));
		assert.equal(objects.get(FILE_ID).metadata.compression, result.method);
	});
});

test("an object replaced between the journal insert and the upload is left alone, and its row is closed", async () =>
{
	const data = compressibleData();
	const other = { body: Buffer.from("someone else's bytes"), contentType: "model/stl", metadata: { x: "1" } };
	let heads = 0;

	await withS3(async (s3, { objects, counters }) =>
	{
		seed(objects, data, { sha256: sha(data) });
		interceptSend(s3, (command, send) =>
		{
			// HEAD #3 is the one taken after the journal insert.
			if (command instanceof HeadObjectCommand && ++heads === 3)
			{
				objects.set(FILE_ID, other);
			}

			return send();
		});

		const result = await archiveOrderFile({ s3, fileId: FILE_ID, compress: testCompressor });

		assert.equal(result.outcome, FILE_OUTCOMES.changed);
		assert.equal(counters.putAttempts, 0);
		assert.equal(objects.get(FILE_ID), other);
		assert.deepEqual(journal.log, ["insert", "delete"]);
		assert.deepEqual(await archiverTempFiles(), []);
	});
});

test("a failing HEAD after the journal insert closes the row and fails the file without uploading", async () =>
{
	const data = compressibleData();
	let heads = 0;

	await withS3(async (s3, { objects, counters }) =>
	{
		seed(objects, data, { sha256: sha(data) });
		interceptSend(s3, (command, send) =>
		{
			if (command instanceof HeadObjectCommand && ++heads === 3)
			{
				return Promise.reject(serviceUnavailable());
			}

			return send();
		});

		await assert.rejects(archiveOrderFile({ s3, fileId: FILE_ID, compress: testCompressor }), /ServiceUnavailable/);
		assert.equal(counters.putAttempts, 0);
		assert.equal(journal.rows.has(FILE_ID), false);
		assert.ok(objects.get(FILE_ID).body.equals(data));
		assert.deepEqual(await archiverTempFiles(), []);
	});
});

// ---- orders.deleting_at in the archiver's order queries ----

// A postgres.js stand-in that records each query's text (`?` where a value goes) and answers with `rows`.
function recordingSql(rows)
{
	const queries = [];
	const sql = (strings, ...values) =>
	{
		queries.push({ text: strings.join("?").replace(/\s+/g, " ").trim(), values });

		return Promise.resolve(rows);
	};

	sql.queries = queries;

	return sql;
}

const NOT_DELETING_CLAUSE = "AND (orders.deleting_at IS NULL OR orders.deleting_at < now() - ?::interval)";

test("markOrderArchived only marks an order whose deletion is not running", async () =>
{
	const files = [FILE_ID];
	const marked = recordingSql([{ order_id: "o1" }]);
	const refused = recordingSql([]);

	assert.equal(await markOrderArchived(marked, "o1", files), true);
	assert.equal(await markOrderArchived(refused, "o1", files), false);

	const [{ text, values }] = marked.queries;

	assert.match(text, /^UPDATE orders SET archived_at = now\(\) WHERE order_id = \?/);
	assert.ok(text.includes("AND files IS NOT DISTINCT FROM ?"));
	assert.ok(text.includes("AND archived_at IS NULL"));
	// An order whose delete is running is left alone; a marker older than the
	// stale limit (a delete that died, judged on the database clock) is not.
	assert.ok(text.includes(NOT_DELETING_CLAUSE), text);
	assert.ok(text.includes("FROM archive_pending_verify"));
	assert.ok(text.endsWith("RETURNING order_id"));
	assert.deepEqual(values, ["o1", files, DELETION_STALE_INTERVAL]);
	assert.equal(DELETION_STALE_AFTER_MS, 15 * 60 * 1000);
});

test("isFileOnOrder requires the order to have no running deletion", async () =>
{
	const present = recordingSql([{ "?column?": 1 }]);
	const absent = recordingSql([]);

	assert.equal(await isFileOnOrder(present, "o1", FILE_ID), true);
	assert.equal(await isFileOnOrder(absent, "o1", FILE_ID), false);

	const [{ text, values }] = present.queries;

	assert.ok(text.includes("AND ? = ANY(files)"));
	assert.ok(text.includes(NOT_DELETING_CLAUSE), text);
	assert.deepEqual(values, ["o1", FILE_ID, DELETION_STALE_INTERVAL]);
});
