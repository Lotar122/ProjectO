import "server-only";

import { Upload } from "@aws-sdk/lib-storage";
import busboy from "busboy";
import { createHash } from "node:crypto";
import { Readable, Transform, pipeline } from "node:stream";
import { v7 as uuid7 } from "uuid";

import { createLogger } from "@/app/lib/logger";
import {
	CHECKSUM_MISMATCH,
	ChecksumMismatchError,
} from "@/app/server-functions/MinIO/checksum";
import { encodeMetadataValue } from "@/app/server-functions/MinIO/metadataEncoding";
import {
	ORDER_FILES_BUCKET,
	cleanUpOrderFiles,
	sanitizeOrderFileName,
	setOrderFileChecksum,
} from "@/app/server-functions/orders/orderFiles";

const log = createLogger("upload");

export const UPLOAD_LIMIT = "UPLOAD_LIMIT";
export const INVALID_UPLOAD = "INVALID_UPLOAD";

// Limits of one request. The client shows them as limits per order (see
// orderUtils.js), so ORDER_LIMITS applies the same numbers to the whole order
// after an edit: without it, repeated edits could each add up to the request
// limit and grow one order without bound (checked in applyOrderEdit.js).
export const UPLOAD_LIMITS = {
	maxFiles: 20,
	maxFileBytes: 250 * 1024 * 1024,
	maxTotalBytes: 1024 * 1024 * 1024,
};

export const ORDER_LIMITS = {
	maxFiles: UPLOAD_LIMITS.maxFiles,
	maxFileBytes: UPLOAD_LIMITS.maxFileBytes,
	maxTotalBytes: UPLOAD_LIMITS.maxTotalBytes,
};

const MAX_FIELDS = 500;
const MAX_FIELD_BYTES = 64 * 1024;
// Multipart framing and the text fields on top of the file bytes.
const MULTIPART_OVERHEAD_BYTES = 4 * 1024 * 1024;
const IDLE_TIMEOUT_MS = 60000;
const PART_SIZE_BYTES = 8 * 1024 * 1024;
const MAX_FILE_NAME_LENGTH = 200;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

// Failures surface through the upload promise and the parser; these calls only need a sink.
function ignoreError()
{
}

export class UploadLimitError extends Error
{
	constructor(message)
	{
		super(message);
		this.name = "UploadLimitError";
		this.code = UPLOAD_LIMIT;
	}
}

export class InvalidUploadError extends Error
{
	constructor(message)
	{
		super(message);
		this.name = "InvalidUploadError";
		this.code = INVALID_UPLOAD;
	}
}

// Maps upload failures to the response the client expects; null means the
// error is not an upload error and the route should treat it as a 500.
export function uploadErrorResponse(err)
{
	if (err instanceof ChecksumMismatchError)
	{
		log.warn(`Upload rejected: checksum mismatch for ${err.files.length} file(s)`);

		return Response.json(
			{ success: false, code: CHECKSUM_MISMATCH, error: err.message, files: err.files },
			{ status: 422 },
		);
	}

	if (err instanceof UploadLimitError)
	{
		log.warn(`Upload rejected: ${err.message}`);

		return Response.json(
			{ success: false, code: UPLOAD_LIMIT, error: err.message },
			{ status: 413 },
		);
	}

	if (err instanceof InvalidUploadError)
	{
		log.warn(`Upload rejected: ${err.message}`);

		return Response.json(
			{ success: false, code: INVALID_UPLOAD, error: err.message },
			{ status: 400 },
		);
	}

	return null;
}

const nextTurn = () => new Promise((resolve) => setImmediate(resolve));

// @aws-sdk/client-s3 is a Next.js server-external package, so command class
// names survive the production build. Matching by name (not instanceof) also
// works when lib-storage and this module load different builds of the SDK.
function isAbortMultipartUpload(command)
{
	return command?.constructor?.name === "AbortMultipartUploadCommand";
}

// Wraps the S3 client so every request it sends can be awaited. `Upload.abort()`
// only stops lib-storage from waiting; a PutObject or CompleteMultipartUpload
// already on the wire can still create the object afterwards, so cleanup has to
// wait for those requests before deleting.
function trackRequests(s3)
{
	const requests = new Set();

	const send = (command, ...rest) =>
	{
		const request = Promise.resolve(s3.send(command, ...rest));
		const forget = () => requests.delete(request);

		requests.add(request);
		request.then(forget, forget);

		if (isAbortMultipartUpload(command))
		{
			// lib-storage swallows this failure once the upload was aborted; the parts stay in storage.
			request.catch((err) =>
			{
				log.error(`Could not abort the multipart upload of ${command.input?.Key}`, err);
			});
		}

		return request;
	};

	const client = new Proxy(s3, {
		get(target, property)
		{
			if (property === "send")
			{
				return send;
			}

			const value = Reflect.get(target, property, target);

			return typeof value === "function" ? value.bind(target) : value;
		},
	});

	// A settled request can trigger a follow-up a few microtasks later (lib-storage
	// sends AbortMultipartUpload once its last UploadPart returns), so the set only
	// counts as drained when it is still empty after a full event-loop turn.
	const settled = async () =>
	{
		do
		{
			while (requests.size > 0)
			{
				await Promise.allSettled([...requests]);
			}

			await nextTurn();
		}
		while (requests.size > 0);
	};

	return { client, settled };
}

// Keeps the last MAX_FILE_NAME_LENGTH code points, so a surrogate pair is never split.
function truncateFileName(name)
{
	const codePoints = Array.from(name);

	return codePoints.length > MAX_FILE_NAME_LENGTH ?
		codePoints.slice(-MAX_FILE_NAME_LENGTH).join("") :
		name;
}

// Streams a multipart order request straight from the request body to S3, so
// a file never has to fit in memory. Contract with the client: every text
// field (including `fileChecksums`, one per file in the same order) comes
// before the first `files` part; a text field after a file is rejected.
//
// `validate` runs once the text fields are complete (before the first file is
// read, so a bad request costs no upload); throw InvalidUploadError from it.
//
// Resolves to { fields, files }, with `files` in request order (each
// { fileID, fileName, sha256, size }, size in bytes). On any failure
// every object this request started is deleted again (after the in-flight
// requests for it have finished) before the error is rethrown.
export async function receiveOrderUpload(req, s3, { validate, limits = UPLOAD_LIMITS } = {})
{
	const contentType = req.headers.get("content-type") || "";

	if (!/^multipart\/form-data/i.test(contentType) || !req.body)
	{
		throw new InvalidUploadError("Expected a multipart/form-data body");
	}

	const declaredLength = Number(req.headers.get("content-length"));

	if (
		Number.isFinite(declaredLength) &&
		declaredLength > limits.maxTotalBytes + MULTIPART_OVERHEAD_BYTES
	)
	{
		throw new UploadLimitError("Request body is too large");
	}

	const fields = new Map();
	const fieldsApi = {
		get: (name) => fields.get(name)?.[0] ?? null,
		getAll: (name) => fields.get(name) ?? [],
	};
	// Indexed by the file's position in the request, not by completion order.
	const uploaded = [];
	const mismatched = [];
	// Every upload this request created: { key, upload, meter }.
	const started = [];
	const inFlight = new Set();
	const pending = [];
	const tracked = trackRequests(s3);
	let fileCount = 0;
	let totalBytes = 0;
	let failure = null;
	let settled = false;
	let idleTimer = null;
	let validated = false;
	let onAbort = null;

	let parser;

	try
	{
		parser = busboy({
			headers: { "content-type": contentType },
			defParamCharset: "utf8",
			limits: {
				files: limits.maxFiles,
				fileSize: limits.maxFileBytes,
				fields: MAX_FIELDS,
				fieldSize: MAX_FIELD_BYTES,
			},
		});
	}
	catch
	{
		throw new InvalidUploadError("Malformed multipart body");
	}

	const body = Readable.fromWeb(req.body);

	const outcome = new Promise((resolve, reject) =>
	{
		const fail = (err) =>
		{
			if (settled)
			{
				return;
			}

			settled = true;
			failure = err;
			clearTimeout(idleTimer);
			reject(err);

			// fail() is often called from inside a busboy event; destroying the
			// parser right there makes busboy touch state it just cleared.
			setImmediate(() =>
			{
				body.unpipe(parser);
				body.destroy();
				parser.destroy();

				for (const upload of inFlight)
				{
					Promise.resolve(upload.abort()).catch(ignoreError);
				}

				// Ends lib-storage's part readers, so its background loop can finish and abort multipart uploads.
				for (const { meter } of started)
				{
					meter.destroy();
				}
			});
		};

		const succeed = () =>
		{
			if (settled)
			{
				return;
			}

			settled = true;
			clearTimeout(idleTimer);
			resolve();
		};

		const touch = () =>
		{
			if (settled)
			{
				return;
			}

			clearTimeout(idleTimer);
			idleTimer = setTimeout(
				() => fail(new InvalidUploadError("Upload stalled")),
				IDLE_TIMEOUT_MS,
			);
		};

		const validateOnce = () =>
		{
			if (!validated)
			{
				validated = true;
				validate?.(fieldsApi);
			}
		};

		const addToField = (name, value) =>
		{
			const values = fields.get(name) ?? [];

			values.push(value);
			fields.set(name, values);
		};

		const startUpload = (fileStream, info, index) =>
		{
			const patient = fieldsApi.get("patient");

			if (patient === null)
			{
				fileStream.resume();
				fail(new InvalidUploadError("Text fields must precede the files"));
				return;
			}

			const rawChecksum = String(fields.get("fileChecksums")?.[index] ?? "")
				.trim()
				.toLowerCase();
			// Anything that is not a SHA-256 hex digest (for example "null") counts as absent.
			const clientChecksum = SHA256_PATTERN.test(rawChecksum) ? rawChecksum : "";
			const originalName = truncateFileName(String(info.filename || "file"));
			const fileName = sanitizeOrderFileName(patient, originalName);
			const encodedFileName = encodeMetadataValue(fileName);
			const fileID = uuid7();
			const hash = createHash("sha256");
			let size = 0;

			const meter = new Transform({
				transform(chunk, encoding, callback)
				{
					touch();
					size += chunk.length;
					totalBytes += chunk.length;

					if (totalBytes > limits.maxTotalBytes)
					{
						const err = new UploadLimitError("Order files are too large in total");

						fail(err);
						callback(err);
						return;
					}

					hash.update(chunk);
					callback(null, chunk);
				},
			});

			const upload = new Upload({
				client: tracked.client,
				params: {
					Bucket: ORDER_FILES_BUCKET,
					Key: fileID,
					Body: meter,
					Metadata: {
						original_name: encodedFileName,
						...(clientChecksum ? { sha256: clientChecksum } : {}),
					},
				},
				queueSize: 2,
				partSize: PART_SIZE_BYTES,
				leavePartsOnError: false,
			});

			started.push({ key: fileID, upload, meter });
			inFlight.add(upload);

			fileStream.on("limit", () =>
			{
				const err = new UploadLimitError(
					`A file exceeds ${limits.maxFileBytes / (1024 * 1024)} MB`,
				);

				fail(err);
				meter.destroy(err);
			});

			pipeline(fileStream, meter, ignoreError);

			pending.push(
				upload
					.done()
					.then(async () =>
					{
						const sha256 = hash.digest("hex");

						uploaded[index] = { fileID, fileName, sha256, size };

						if (clientChecksum && clientChecksum !== sha256)
						{
							mismatched[index] = originalName;
							return;
						}

						if (!clientChecksum)
						{
							// The browser could not hash the file; store the server's hash instead.
							await setOrderFileChecksum(s3, fileID, sha256).catch((err) =>
							{
								log.warn(`Could not store checksum for ${fileID}: ${err.message}`);
							});
						}
					})
					.catch(fail)
					.finally(() => inFlight.delete(upload)),
			);
		};

		parser.on("field", (name, value, info) =>
		{
			if (info.valueTruncated || info.nameTruncated)
			{
				fail(new InvalidUploadError(`Field "${name}" is too long`));
				return;
			}

			// `validate` already ran on the fields before the first file.
			if (fileCount > 0)
			{
				fail(new InvalidUploadError("Text fields must precede the files"));
				return;
			}

			addToField(name, value);
		});

		parser.on("filesLimit", () =>
		{
			fail(new UploadLimitError(`At most ${limits.maxFiles} files per order`));
		});

		parser.on("fieldsLimit", () =>
		{
			fail(new InvalidUploadError("Too many fields"));
		});

		parser.on("file", (name, fileStream, info) =>
		{
			// Destroying the parser mid-file errors the file stream; that is already reported through fail().
			fileStream.on("error", ignoreError);

			if (failure || name !== "files")
			{
				fileStream.resume();
				return;
			}

			const index = fileCount++;

			// A throw here would escape the busboy event, so it is turned into a failed upload.
			try
			{
				validateOnce();
				startUpload(fileStream, info, index);
			}
			catch (err)
			{
				fileStream.resume();
				fail(err);
			}
		});

		parser.on("error", fail);
		body.on("error", fail);
		body.on("data", touch);

		onAbort = () => fail(new InvalidUploadError("Request aborted"));
		req.signal?.addEventListener("abort", onAbort, { once: true });

		parser.on("close", () =>
		{
			try
			{
				if (!failure)
				{
					validateOnce();
				}
			}
			catch (err)
			{
				fail(err);
				return;
			}

			Promise.all(pending).then(succeed);
		});

		touch();
		body.pipe(parser);
	});

	try
	{
		try
		{
			await outcome;
		}
		finally
		{
			clearTimeout(idleTimer);
			req.signal?.removeEventListener("abort", onAbort);
		}

		const mismatchedNames = mismatched.filter((name) => name !== undefined);

		if (mismatchedNames.length > 0)
		{
			throw new ChecksumMismatchError(mismatchedNames);
		}
	}
	catch (err)
	{
		// An aborted upload's done() settles at once, but lib-storage keeps running
		// in the background: an in-flight request can still create the object, and
		// AbortMultipartUpload only goes out once its part uploaders have returned
		// (`concurrentUploaders` never reject). Wait for all of it before deleting.
		await Promise.allSettled(pending);
		await Promise.allSettled(started.flatMap(({ upload }) => upload.concurrentUploaders ?? []));
		await tracked.settled();
		await cleanUpOrderFiles(s3, started.map(({ key }) => key), {
			log,
			context: "a failed upload",
		});

		throw err;
	}

	return {
		fields: fieldsApi,
		files: uploaded.filter(Boolean),
	};
}
