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
	deleteOrderFiles,
	sanitizeOrderFileName,
	setOrderFileChecksum,
} from "@/app/server-functions/orders/orderFiles";

const log = createLogger("upload");

export const UPLOAD_LIMIT = "UPLOAD_LIMIT";
export const INVALID_UPLOAD = "INVALID_UPLOAD";

export const UPLOAD_LIMITS = {
	maxFiles: 20,
	maxFileBytes: 250 * 1024 * 1024,
	maxTotalBytes: 1024 * 1024 * 1024,
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

// Streams a multipart order request straight from the request body to S3, so
// a file never has to fit in memory. Contract with the client: every text
// field (including `fileChecksums`, one per file in the same order) comes
// before the first `files` part.
//
// `validate` runs once the text fields are complete (before the first file is
// read, so a bad request costs no upload); throw InvalidUploadError from it.
//
// Resolves to { fields, files }. On any failure the objects already written
// by this request are deleted again before the error is rethrown.
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
	const uploaded = [];
	const inFlight = new Set();
	const mismatched = [];
	const pending = [];
	let fileCount = 0;
	let totalBytes = 0;
	let failure = null;
	let idleTimer = null;
	let validated = false;

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
			if (failure)
			{
				return;
			}

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
			});
		};

		const touch = () =>
		{
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

		parser.on("field", (name, value, info) =>
		{
			if (info.valueTruncated || info.nameTruncated)
			{
				fail(new InvalidUploadError(`Field "${name}" is too long`));
				return;
			}

			if (fileCount > 0 && name === "fileChecksums")
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

			try
			{
				validateOnce();
			}
			catch (err)
			{
				fileStream.resume();
				fail(err);
				return;
			}

			const patient = fieldsApi.get("patient");

			if (patient === null)
			{
				fileStream.resume();
				fail(new InvalidUploadError("Text fields must precede the files"));
				return;
			}

			const clientChecksum = String(fields.get("fileChecksums")?.[index] ?? "")
				.trim()
				.toLowerCase();
			const originalName = String(info.filename || "file").slice(-MAX_FILE_NAME_LENGTH);
			const fileName = sanitizeOrderFileName(patient, originalName);
			const fileID = uuid7();
			const hash = createHash("sha256");

			const meter = new Transform({
				transform(chunk, encoding, callback)
				{
					touch();
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

			fileStream.on("limit", () =>
			{
				const err = new UploadLimitError(
					`A file exceeds ${limits.maxFileBytes / (1024 * 1024)} MB`,
				);

				fail(err);
				meter.destroy(err);
			});

			pipeline(fileStream, meter, ignoreError);

			const upload = new Upload({
				client: s3,
				params: {
					Bucket: ORDER_FILES_BUCKET,
					Key: fileID,
					Body: meter,
					Metadata: {
						original_name: encodeMetadataValue(fileName),
						...(SHA256_PATTERN.test(clientChecksum) ? { sha256: clientChecksum } : {}),
					},
				},
				queueSize: 2,
				partSize: PART_SIZE_BYTES,
				leavePartsOnError: false,
			});

			inFlight.add(upload);

			pending.push(
				upload
					.done()
					.then(async () =>
					{
						const sha256 = hash.digest("hex");

						uploaded.push({ fileID, fileName, sha256 });

						if (clientChecksum !== "" && clientChecksum !== sha256)
						{
							mismatched.push(originalName);
							return;
						}

						if (!SHA256_PATTERN.test(clientChecksum))
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
		});

		parser.on("error", fail);
		body.on("error", fail);
		body.on("data", touch);
		req.signal?.addEventListener("abort", () => fail(new InvalidUploadError("Request aborted")), { once: true });

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

			Promise.all(pending).then(() =>
			{
				clearTimeout(idleTimer);

				if (!failure)
				{
					resolve();
				}
			});
		});

		touch();
		body.pipe(parser);
	});

	try
	{
		await outcome;

		if (mismatched.length > 0)
		{
			throw new ChecksumMismatchError(mismatched);
		}
	}
	catch (err)
	{
		clearTimeout(idleTimer);
		await deleteOrderFiles(s3, uploaded.map((file) => file.fileID)).catch((cleanupErr) =>
		{
			log.error("Could not remove files of a failed upload", cleanupErr);
		});

		throw err;
	}

	return {
		fields: fieldsApi,
		files: uploaded,
	};
}
