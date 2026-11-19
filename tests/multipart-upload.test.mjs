import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createHash } from "node:crypto";
import { mock } from "bun:test";
import { S3Client } from "@aws-sdk/client-s3";
import {
	InvalidUploadError,
	UploadLimitError,
	receiveOrderUpload,
} from "../src/app/server-functions/orders/multipartUpload.js";
import { ChecksumMismatchError } from "../src/app/server-functions/MinIO/checksum.js";
import { decodeMetadataValue } from "../src/app/server-functions/MinIO/metadataEncoding.js";
import { createFakeS3 } from "./helpers/fakeS3.mjs";

const sha = (text) => createHash("sha256").update(text).digest("hex");

const ORDER_FILES_MODULE = Bun.fileURLToPath(
	new URL("../src/app/server-functions/orders/orderFiles.js", import.meta.url),
);

const nextTurn = () => new Promise((resolve) => setImmediate(resolve));

const WAIT_LIMIT_MS = 5000;

// Polls, one event-loop turn at a time, until `condition` holds.
async function waitUntil(condition, description)
{
	const deadline = Date.now() + WAIT_LIMIT_MS;

	while (!condition())
	{
		if (Date.now() > deadline)
		{
			throw new Error(`Timed out waiting for ${description}`);
		}

		await nextTurn();
	}
}

// Awaits `promise`, failing the test instead of hanging if it never settles.
async function within(promise, description)
{
	let timer;
	const timeout = new Promise((resolve, reject) =>
	{
		timer = setTimeout(() => reject(new Error(`Timed out waiting for ${description}`)), WAIT_LIMIT_MS);
	});

	try
	{
		return await Promise.race([promise, timeout]);
	}
	finally
	{
		clearTimeout(timer);
	}
}

// Settles to { value } or { error }, so a test can act before awaiting it.
const capture = (promise) => promise.then(
	(value) => ({ value }),
	(error) => ({ error }),
);

// Replaces console.error while `fn` runs and returns the lines it received.
async function captureErrorLog(fn)
{
	const lines = [];
	const original = console.error;

	console.error = (...args) =>
	{
		lines.push(args.map(String).join(" "));
	};

	try
	{
		await fn();
	}
	finally
	{
		console.error = original;
	}

	return lines;
}

// Minimal S3 stand-in: stores PUT bodies (including multipart uploads) and honours DeleteObjects.
async function withS3(fn)
{
	const objects = new Map();
	const multipart = new Map();
	let putCount = 0;
	const server = http.createServer((req, res) =>
	{
		const chunks = [];

		req.on("data", (chunk) => chunks.push(chunk));
		req.on("end", () =>
		{
			const url = new URL(req.url, "http://localhost");
			const key = url.pathname.split("/").slice(2).join("/");

			if (req.method === "POST" && url.searchParams.has("uploads"))
			{
				multipart.set("u1", { key, metadata: req.headers, parts: new Map() });
				res.writeHead(200, { "Content-Type": "application/xml" }).end(
					"<InitiateMultipartUploadResult><UploadId>u1</UploadId></InitiateMultipartUploadResult>",
				);
				return;
			}

			if (req.method === "PUT" && url.searchParams.has("partNumber"))
			{
				putCount++;
				multipart.get(url.searchParams.get("uploadId")).parts.set(
					Number(url.searchParams.get("partNumber")),
					Buffer.concat(chunks),
				);
				res.writeHead(200, { ETag: `"part${url.searchParams.get("partNumber")}"` }).end();
				return;
			}

			if (req.method === "POST" && url.searchParams.has("uploadId"))
			{
				const upload = multipart.get(url.searchParams.get("uploadId"));
				const body = Buffer.concat([...upload.parts.entries()].sort((a, b) => a[0] - b[0]).map(([, part]) => part));

				objects.set(upload.key, { body, metadata: upload.metadata });
				res.writeHead(200, { "Content-Type": "application/xml" }).end(
					"<CompleteMultipartUploadResult><ETag>\"done\"</ETag></CompleteMultipartUploadResult>",
				);
				return;
			}

			if (req.method === "DELETE" && url.searchParams.has("uploadId"))
			{
				multipart.delete(url.searchParams.get("uploadId"));
				res.writeHead(204).end();
				return;
			}

			if (req.method === "PUT")
			{
				putCount++;
				objects.set(key, { body: Buffer.concat(chunks), metadata: req.headers });
				res.writeHead(200, { ETag: '"etag"' }).end();
				return;
			}

			if (req.method === "POST" && url.searchParams.has("delete"))
			{
				const xml = Buffer.concat(chunks).toString();

				for (const [, deletedKey] of xml.matchAll(/<Key>([^<]+)<\/Key>/g))
				{
					objects.delete(deletedKey);
				}

				res.writeHead(200, { "Content-Type": "application/xml" }).end("<DeleteResult></DeleteResult>");
				return;
			}

			res.writeHead(200).end();
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
		await fn(s3, { objects, getPutCount: () => putCount });
	}
	finally
	{
		s3.destroy();
		server.close();
	}
}

function buildRequest(entries)
{
	const formData = new FormData();

	for (const [name, value, fileName] of entries)
	{
		if (fileName)
		{
			formData.append(name, new File([value], fileName));
		}
		else
		{
			formData.append(name, value);
		}
	}

	return new Request("http://localhost/api/postOrder", { method: "POST", body: formData });
}

// Like buildRequest, but the body stream never ends on its own, and
// `tornDown` resolves when receiveOrderUpload destroys it, which it does only
// after it has failed. Lets a test hold an S3 request until the failure is certain.
// With `holdAt`, only the first `holdAt` bytes are sent until `sendRest()`.
async function buildObservedRequest(entries, { holdAt = Infinity } = {})
{
	const template = buildRequest(entries);
	// Read before the body: Bun derives a FormData request's content type lazily and loses it once the body is consumed.
	const contentType = template.headers.get("content-type");
	const bytes = new Uint8Array(await template.arrayBuffer());
	let markTornDown;
	let bodyController;
	const tornDown = new Promise((resolve) =>
	{
		markTornDown = resolve;
	});
	const body = new ReadableStream({
		start(controller)
		{
			bodyController = controller;
			controller.enqueue(bytes.subarray(0, holdAt));
		},
		cancel()
		{
			markTornDown();
		},
	});
	const sendRest = () =>
	{
		if (holdAt < bytes.length)
		{
			bodyController.enqueue(bytes.subarray(holdAt));
		}
	};
	const req = new Request(template.url, {
		method: "POST",
		headers: { "content-type": contentType },
		body,
		duplex: "half",
	});

	return { req, tornDown, sendRest };
}

test("streams files to S3 and returns fields and file records", async () =>
{
	await withS3(async (s3, { objects }) =>
	{
		const req = buildRequest([
			["patient", "Jan Kowalski"],
			["details", "Zęby"],
			["fileChecksums", sha("alpha")],
			["fileChecksums", sha("beta")],
			["files", "alpha", "upper-jan-kowalski.stl"],
			["files", "beta", "notes.txt"],
		]);
		const { fields, files } = await receiveOrderUpload(req, s3);

		assert.equal(fields.get("patient"), "Jan Kowalski");
		assert.equal(fields.get("details"), "Zęby");
		assert.equal(files.length, 2);
		assert.equal(files[0].fileName, "UpperJawScan.stl");
		assert.equal(files[0].sha256, sha("alpha"));
		assert.equal(objects.size, 2);
		assert.equal(objects.get(files[1].fileID).body.toString(), "beta");
		assert.equal(objects.get(files[1].fileID).metadata["x-amz-meta-sha256"], sha("beta"));
	});
});

test("deletes everything when a checksum does not match", async () =>
{
	await withS3(async (s3, { objects }) =>
	{
		const req = buildRequest([
			["patient", "Jan"],
			["fileChecksums", sha("alpha")],
			["fileChecksums", sha("WRONG")],
			["files", "alpha", "a.txt"],
			["files", "beta", "b.txt"],
		]);

		await assert.rejects(
			receiveOrderUpload(req, s3),
			(err) => err instanceof ChecksumMismatchError && err.files.join() === "b.txt",
		);
		assert.equal(objects.size, 0);
	});
});

test("rejects a file over the per-file limit and leaves nothing behind", async () =>
{
	await withS3(async (s3, { objects }) =>
	{
		const req = buildRequest([
			["patient", "Jan"],
			["fileChecksums", ""],
			["files", "x".repeat(100), "big.bin"],
		]);

		await assert.rejects(
			receiveOrderUpload(req, s3, {
				limits: { maxFiles: 5, maxFileBytes: 10, maxTotalBytes: 1000 },
			}),
			UploadLimitError,
		);
		assert.equal(objects.size, 0);
	});
});

test("rejects too many files and deletes every file it started", async () =>
{
	const s3 = createFakeS3();
	const gate = s3.gate();
	const req = buildRequest([
		["patient", "Jan"],
		["files", "1", "1.txt"],
		["files", "2", "2.txt"],
		["files", "3", "3.txt"],
	]);
	const outcome = receiveOrderUpload(req, s3, {
		limits: { maxFiles: 2, maxFileBytes: 1000, maxTotalBytes: 1000 },
	}).then(
		(value) => ({ value }),
		(error) => ({ error }),
	);

	// busboy parses the small body in one pass, so filesLimit has already fired
	// by the time the first (gated) PutObject is sent.
	await s3.waitForStarted(1);
	await new Promise((resolve) => setImmediate(resolve));

	gate.release();

	const { value, error } = await outcome;

	await s3.settled();

	assert.equal(value, undefined);
	assert.ok(error instanceof UploadLimitError);
	assert.ok(s3.started.length >= 1);
	assert.deepEqual([...s3.objects.keys()], [], "an upload that finished after the failure was left behind");
});

test("rejects when the total size is exceeded", async () =>
{
	await withS3(async (s3, { objects }) =>
	{
		const req = buildRequest([
			["patient", "Jan"],
			["files", "x".repeat(60), "1.bin"],
			["files", "x".repeat(60), "2.bin"],
		]);

		await assert.rejects(
			receiveOrderUpload(req, s3, {
				limits: { maxFiles: 5, maxFileBytes: 100, maxTotalBytes: 100 },
			}),
			UploadLimitError,
		);
		assert.equal(objects.size, 0);
	});
});

test("validation failure happens before any file is uploaded", async () =>
{
	await withS3(async (s3, { getPutCount }) =>
	{
		const req = buildRequest([
			["patient", ""],
			["files", "alpha", "a.txt"],
		]);

		await assert.rejects(
			receiveOrderUpload(req, s3, {
				validate: (fields) =>
				{
					if (!fields.get("patient"))
					{
						throw new InvalidUploadError("patient required");
					}
				},
			}),
			InvalidUploadError,
		);
		assert.equal(getPutCount(), 0);
	});
});

test("rejects files that arrive before the text fields", async () =>
{
	await withS3(async (s3) =>
	{
		const req = buildRequest([
			["files", "alpha", "a.txt"],
			["patient", "Jan"],
		]);

		await assert.rejects(receiveOrderUpload(req, s3), InvalidUploadError);
	});
});

test("rejects non-multipart bodies", async () =>
{
	await withS3(async (s3) =>
	{
		const req = new Request("http://localhost/x", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: "{}",
		});

		await assert.rejects(receiveOrderUpload(req, s3), InvalidUploadError);
	});
});

test("uploads a file larger than one part through the multipart API", async () =>
{
	await withS3(async (s3, { objects }) =>
	{
		const content = Buffer.alloc(20 * 1024 * 1024, "abcdefghij");
		const checksum = createHash("sha256").update(content).digest("hex");
		const formData = new FormData();

		formData.append("patient", "Jan");
		formData.append("fileChecksums", checksum);
		formData.append("files", new File([content], "scan.stl"));

		const req = new Request("http://localhost/x", { method: "POST", body: formData });
		const { files } = await receiveOrderUpload(req, s3);

		assert.equal(files.length, 1);
		assert.equal(files[0].sha256, checksum);
		assert.equal(
			createHash("sha256").update(objects.get(files[0].fileID).body).digest("hex"),
			checksum,
		);
	});
});

test("an upload that completes after the failure is deleted too", async () =>
{
	const s3 = createFakeS3();
	const gate = s3.gate((key) => key === s3.started[0]);
	const { req, tornDown } = await buildObservedRequest([
		["patient", "Jan"],
		["files", "small", "a.txt"],
		["files", "x".repeat(100), "big.bin"],
	]);
	let requestSettled = false;
	const outcome = capture(receiveOrderUpload(req, s3, {
		limits: { maxFiles: 5, maxFileBytes: 10, maxTotalBytes: 1000 },
	})).finally(() =>
	{
		requestSettled = true;
	});

	await s3.waitForStarted(1);

	const [lateKey] = s3.started;

	// The request has failed (and torn down its body) while the first PutObject is still held.
	await within(tornDown, "the failed request to tear down its body");
	await nextTurn();
	assert.equal(s3.objects.has(lateKey), false);
	assert.equal(requestSettled, false, "the request settled before its in-flight upload finished");
	assert.equal(s3.callsOf("DeleteObjects").length, 0, "cleanup did not wait for the in-flight upload");
	gate.release();

	const { value, error } = await outcome;

	await s3.settled();

	assert.equal(value, undefined);
	assert.ok(error instanceof UploadLimitError);
	assert.ok(s3.deleted.includes(lateKey), "the late upload was never deleted");
	assert.deepEqual([...s3.objects.keys()], []);
});

test("truncates a long file name by code point, never splitting a surrogate pair", async () =>
{
	const s3 = createFakeS3();
	// 300 emoji (600 UTF-16 code units) and a 3-character extension: cutting the
	// last 200 code units would start the name with a lone low surrogate.
	const longName = `${"\u{1F600}".repeat(300)}.md`;
	const req = buildRequest([
		["patient", "Jan"],
		["files", "content", longName],
	]);
	const { files } = await receiveOrderUpload(req, s3);

	assert.equal(files.length, 1);

	const { fileName } = files[0];

	assert.equal(Array.from(fileName).length, 200);
	assert.ok(fileName.isWellFormed(), "file name contains a lone surrogate");
	assert.equal(fileName, `${"\u{1F600}".repeat(197)}.md`);
	assert.equal(decodeMetadataValue(s3.objects.get(files[0].fileID).metadata.original_name), fileName);
});

test("an error thrown while starting a file upload rejects the request cleanly", async () =>
{
	const realOrderFiles = { ...(await import(ORDER_FILES_MODULE)) };
	const thrown = new Error("sanitize exploded");
	const unexpected = [];
	const onUnexpected = (err) =>
	{
		unexpected.push(err);
	};

	mock.module(ORDER_FILES_MODULE, () => ({
		...realOrderFiles,
		sanitizeOrderFileName: () =>
		{
			throw thrown;
		},
	}));
	process.on("uncaughtException", onUnexpected);
	process.on("unhandledRejection", onUnexpected);

	try
	{
		const s3 = createFakeS3();
		const req = buildRequest([
			["patient", "Jan"],
			["files", "alpha", "a.txt"],
			["files", "beta", "b.txt"],
		]);
		const { value, error } = await capture(receiveOrderUpload(req, s3));

		await nextTurn();
		await s3.settled();

		assert.equal(value, undefined);
		assert.equal(error, thrown);
		assert.deepEqual(s3.started, []);
		assert.deepEqual([...s3.objects.keys()], []);
		assert.deepEqual(unexpected, []);
	}
	finally
	{
		process.off("uncaughtException", onUnexpected);
		process.off("unhandledRejection", onUnexpected);
		mock.module(ORDER_FILES_MODULE, () => realOrderFiles);
	}
});

test("rejects a text field that arrives after a file and stores nothing", async () =>
{
	const s3 = createFakeS3();
	const seen = [];
	const req = buildRequest([
		["patient", "Jan"],
		["details", "first"],
		["files", "alpha", "a.txt"],
		["details", "late"],
	]);

	await assert.rejects(
		receiveOrderUpload(req, s3, {
			validate: (fields) =>
			{
				seen.push(fields.getAll("details").join());
			},
		}),
		(err) => err instanceof InvalidUploadError && /precede the files/.test(err.message),
	);
	await s3.settled();

	assert.deepEqual(seen, ["first"]);
	assert.deepEqual([...s3.objects.keys()], []);
});

test("returns the files in request order, whatever order the uploads finish in", async () =>
{
	const s3 = createFakeS3();
	const contents = ["first", "second", "third"];
	const bodyOf = (key) => s3.callsOf("PutObject").find((call) => call.key === key)?.input.Body?.toString();
	const gates = contents.map((content) => s3.gate((key) => bodyOf(key) === content));
	const landed = [];
	const req = buildRequest([
		["patient", "Jan"],
		...contents.map((content, index) => ["files", content, `${index + 1}.txt`]),
	]);
	const outcome = capture(receiveOrderUpload(req, s3));

	await s3.waitForStarted(contents.length);

	for (let index = contents.length - 1; index >= 0; index--)
	{
		gates[index].release();
		await waitUntil(
			() => [...s3.objects.values()].some((object) => object.body?.toString() === contents[index]),
			`upload ${index + 1} to land`,
		);
		landed.push(contents[index]);
	}

	const { value, error } = await outcome;

	assert.equal(error, undefined);
	assert.deepEqual(landed, ["third", "second", "first"]);
	assert.deepEqual(value.files.map((file) => file.fileName), ["1.txt", "2.txt", "3.txt"]);
	assert.deepEqual(
		value.files.map((file) => s3.objects.get(file.fileID).body.toString()),
		contents,
	);
});

test("treats a malformed checksum as absent and stores the server hash", async () =>
{
	const s3 = createFakeS3();
	const req = buildRequest([
		["patient", "Jan"],
		["fileChecksums", "null"],
		["files", "alpha", "a.txt"],
	]);
	const { files } = await receiveOrderUpload(req, s3);

	assert.equal(files.length, 1);
	assert.equal(files[0].sha256, sha("alpha"));

	const [put] = s3.callsOf("PutObject");

	assert.equal(put.input.Metadata.sha256, undefined);

	const copies = s3.callsOf("CopyObject");

	assert.equal(copies.length, 1, "setOrderFileChecksum was not called");
	assert.equal(copies[0].key, files[0].fileID);
	assert.equal(s3.objects.get(files[0].fileID).metadata.sha256, sha("alpha"));
});

test("logs the ids a failed upload could not delete", async () =>
{
	const s3 = createFakeS3();
	const send = s3.send;

	// Storage refuses every delete: DeleteObjects resolves with per-key errors.
	s3.send = (command) =>
	{
		if (command?.constructor?.name === "DeleteObjectsCommand")
		{
			s3.calls.push({ type: "DeleteObjects", key: undefined, input: command.input });

			return Promise.resolve({
				Errors: command.input.Delete.Objects.map(({ Key }) => ({ Key, Code: "AccessDenied" })),
			});
		}

		return send(command);
	};

	const req = buildRequest([
		["patient", "Jan"],
		["fileChecksums", sha("WRONG")],
		["files", "alpha", "a.txt"],
	]);
	let rejection;
	const lines = await captureErrorLog(async () =>
	{
		rejection = await capture(receiveOrderUpload(req, s3));
	});

	assert.ok(rejection.error instanceof ChecksumMismatchError);

	const [fileID] = s3.started;
	const leftover = lines.filter((line) => line.includes("left in storage"));

	assert.equal(leftover.length, 1, `expected one error line, got: ${lines.join(" | ")}`);
	assert.match(leftover[0], /ERROR/);
	assert.match(leftover[0], /1 file\(s\)/);
	assert.ok(leftover[0].includes(fileID), "the undeleted id is missing from the log");
	assert.equal(s3.callsOf("DeleteObjects").length, 2, "failed ids are retried once");
});

test("a failure during a multipart upload aborts it before the request settles", async () =>
{
	const s3 = createFakeS3();
	const gate = s3.gate();
	const content = Buffer.alloc(20 * 1024 * 1024, "abcdefghij");
	// 10 MB first: enough for part 1 (8 MB), below the 12 MB total limit.
	const { req, tornDown, sendRest } = await buildObservedRequest([
		["patient", "Jan"],
		["files", content, "scan.stl"],
	], { holdAt: 10 * 1024 * 1024 });
	let callsAtSettle = null;
	const outcome = capture(receiveOrderUpload(req, s3, {
		limits: { maxFiles: 5, maxFileBytes: 100 * 1024 * 1024, maxTotalBytes: 12 * 1024 * 1024 },
	})).finally(() =>
	{
		callsAtSettle = s3.calls.map((call) => call.type);
	});

	await waitUntil(() => s3.callsOf("UploadPart").length > 0, "part 1 to be sent");

	// The rest trips the total-size limit while part 1 is held at the gate.
	sendRest();
	await within(tornDown, "the failed request to tear down its body");
	await nextTurn();
	assert.equal(callsAtSettle, null, "the request settled before its in-flight part finished");
	gate.release();

	const { value, error } = await outcome;

	await s3.settled();

	assert.equal(value, undefined);
	assert.ok(error instanceof UploadLimitError);
	assert.ok(callsAtSettle.includes("CreateMultipartUpload"), "the upload never went multipart");

	const abortIndex = callsAtSettle.indexOf("AbortMultipartUpload");
	const deleteIndex = callsAtSettle.indexOf("DeleteObjects");

	assert.notEqual(abortIndex, -1, "AbortMultipartUpload was not sent before the request settled");
	assert.ok(abortIndex < deleteIndex, `cleanup ran before the abort: ${callsAtSettle.join(", ")}`);
	assert.equal(s3.callsOf("CompleteMultipartUpload").length, 0);
	assert.deepEqual([...s3.objects.keys()], []);
});

test("leaves no idle timer behind once the upload has settled", async () =>
{
	const IDLE_TIMEOUT_MS = 60000;
	const realSetTimeout = globalThis.setTimeout;
	const realClearTimeout = globalThis.clearTimeout;
	const armed = new Set();
	let armedTotal = 0;

	globalThis.setTimeout = (callback, delay, ...args) =>
	{
		const handle = realSetTimeout(callback, delay, ...args);

		if (delay === IDLE_TIMEOUT_MS)
		{
			armed.add(handle);
			armedTotal++;
		}

		return handle;
	};
	globalThis.clearTimeout = (handle) =>
	{
		armed.delete(handle);
		realClearTimeout(handle);
	};

	try
	{
		const s3 = createFakeS3();
		const { files } = await receiveOrderUpload(buildRequest([
			["patient", "Jan"],
			["files", "alpha", "a.txt"],
		]), s3);

		assert.equal(files.length, 1);
		await nextTurn();
		assert.ok(armedTotal > 0, "the idle timer was never armed, so this test checks nothing");
		assert.equal(armed.size, 0, "an idle timer is still pending after success");

		await assert.rejects(
			receiveOrderUpload(buildRequest([
				["patient", "Jan"],
				["files", "alpha", "a.txt"],
				["details", "late"],
			]), s3),
			InvalidUploadError,
		);
		await nextTurn();
		assert.equal(armed.size, 0, "an idle timer is still pending after a failure");
	}
	finally
	{
		globalThis.setTimeout = realSetTimeout;
		globalThis.clearTimeout = realClearTimeout;

		for (const handle of armed)
		{
			realClearTimeout(handle);
		}
	}
});
