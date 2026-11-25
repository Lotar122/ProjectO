import "server-only";

import {
	AbortMultipartUploadCommand,
	CopyObjectCommand,
	DeleteObjectCommand,
	GetObjectCommand,
	HeadObjectCommand,
	ListMultipartUploadsCommand,
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { chmod, copyFile, lstat, mkdir, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Transform, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";

import { createDbClient } from "@/app/lib/db";
import { createLogger } from "@/app/lib/logger";
import { DELETION_STALE_INTERVAL } from "@/app/server-functions/orders/orderRowLock";
import { isUuid } from "@/app/lib/validate";
import { isTempOriginal, recoveryDir, recoveryPaths } from "@/app/server-functions/orders/archiverRecovery";
import {
	ChecksumMismatchError,
	assertChecksum,
	isSha256Hex,
} from "@/app/server-functions/MinIO/checksum";
import { createS3Client } from "@/app/server-functions/MinIO/createS3Client";
import { getFile } from "@/app/server-functions/MinIO/getFile";
import {
	ARCHIVE_META,
	COMPRESSION_METHODS,
	createDecompressStream,
	createTempFilePath,
	removeTempFile,
} from "@/app/server-functions/orders/fileCompression";
import {
	ARCHIVE_AFTER_DAYS,
	countArchiveCandidates,
	selectArchiveCandidates,
} from "@/app/server-functions/orders/archiveCandidates";
import { isJobRunning } from "@/app/server-functions/orders/archiveJobs";
import {
	deletePendingVerify,
	deletePendingVerifyAttempt,
	insertPendingVerify,
	isFileOnAnyOrder,
	listJournalOriginalPaths,
	listPendingVerifications,
	markPendingNeedsAttention,
	markPendingUploaded,
} from "@/app/server-functions/orders/archiveJournal";
import {
	ORDER_FILES_BUCKET,
	isPreconditionFailed,
	updateOrderFileMetadata,
} from "@/app/server-functions/orders/orderFiles";

const log = createLogger("archiver");

export { ARCHIVE_AFTER_DAYS, countArchiveCandidates, selectArchiveCandidates };
export const MIN_SAVINGS_RATIO = 0.02;

// Optional metadata key with the encoder that wrote the archive (for example
// "projecto-compress/1.0.0 zstd/1.5.7"), for later forensics. Nothing reads it.
export const ENCODER_META_KEY = "encoder";
// S3 metadata travels as HTTP headers: printable ASCII only, kept short.
const ENCODER_PATTERN = /^[\x20-\x7e]{1,200}$/;

// Session-level advisory lock that keeps two archiver workers from archiving
// at the same time. Any constant works as long as nothing else uses it.
const ARCHIVE_LOCK_KEY = "5067091845220771";
const PART_SIZE_BYTES = 8 * 1024 * 1024;
const SIZE_PATTERN = /^\d+$/;

// Temp files the archiver leaves in os.tmpdir() (createTempFilePath): the
// downloaded original has no extension, compressed candidates end in .zst/.br.
const TEMP_FILE_PREFIX = "projecto-archive-";
const TEMP_CANDIDATE_PATTERN = /\.(zst|br)$/;
// The temp sweep leaves any temp file modified more recently than this: it may
// belong to an archive still in flight (an orphaned compressor still writing
// its candidate after the worker was killed, or a download in progress).
export const TEMP_SWEEP_MIN_AGE_MS = 10 * 60 * 1000;
// Downloaded originals and recovery copies hold patient data: owner only.
const PRIVATE_FILE_MODE = 0o600;
const PRIVATE_DIR_MODE = 0o700;
// Read-back attempts when reading the stored object fails for a reason that
// says nothing about its bytes (network error, 5xx).
const READBACK_ATTEMPTS = 2;
const TRANSIENT_NETWORK_CODES = new Set([
	"ECONNRESET",
	"ECONNREFUSED",
	"ECONNABORTED",
	"ETIMEDOUT",
	"EPIPE",
	"EAI_AGAIN",
	"EHOSTUNREACH",
	"ENETUNREACH",
	"ERR_STREAM_PREMATURE_CLOSE",
	"UND_ERR_SOCKET",
]);
// Upper bound for ListMultipartUploads pages per key during recovery.
const MAX_MULTIPART_LIST_PAGES = 100;
const JOURNAL_METHODS = new Set([COMPRESSION_METHODS.zstd, COMPRESSION_METHODS.brotli]);

// Upper bound for the lock queries on the lock connection (and the job's
// other queries). A dropped connection can leave a postgres.js query pending
// for a long time; without a bound the job would stay "running" and every
// new start would be refused until a restart.
export const DB_TIMEOUT_MS = 20_000;

// What archiveOrderFile did with one file.
export const FILE_OUTCOMES = {
	// Recompressed and replaced in S3.
	compressed: "compressed",
	// Compression would not pay off; only compression=identity was recorded.
	incompressible: "incompressible",
	// An earlier run already handled the file (it has a compression marker).
	alreadyArchived: "already-archived",
	// Compressed, but the order was deleted meanwhile, so the object was removed.
	orphaned: "orphaned",
	// The object was replaced or deleted by someone else while it was being
	// archived, so nothing was written (or our write was refused). Not an
	// error: the order is not marked archived and the next run retries it.
	changed: "changed",
	// archiveOrderFile threw (e.g. ChecksumMismatchError); the object is left
	// as it was (or restored) and the order is not marked archived.
	failed: "failed",
};

// Re-exported so callers can tell a checksum failure from other failures.
export { ChecksumMismatchError };

export class ArchiveFileError extends Error
{
	/**
	 * @param {string} message
	 * @param {{ cause?: unknown }} [options]
	 */
	constructor(message, options)
	{
		super(message, options);
		this.name = "ArchiveFileError";
	}
}

class ObjectChangedError extends ArchiveFileError
{
	constructor()
	{
		super("Object changed while it was being archived");
		this.name = "ObjectChangedError";
	}
}

class DbTimeoutError extends Error
{
	constructor(label, ms)
	{
		super(`${label} timed out after ${ms} ms`);
		this.name = "DbTimeoutError";
	}
}

// The stored archive was read, but decoding it failed (a decoder error, or
// the decoder ending or closing before the source did). Judges the archive's
// bytes, so it is never transient, whatever code the underlying error has
// (a decoder that stops early surfaces as ERR_STREAM_PREMATURE_CLOSE).
class StoredArchiveDecodeError extends ArchiveFileError
{
	constructor(cause)
	{
		super(`Stored archive could not be decoded: ${cause?.message ?? String(cause)}`, { cause });
		this.name = "StoredArchiveDecodeError";
	}
}

// The read-back could not read the stored object (network error, 5xx), so it
// says nothing about the archive's bytes. Never a reason to restore.
class ReadBackUnavailableError extends ArchiveFileError
{
	constructor(cause)
	{
		super(`Could not read the stored object back: ${cause?.message ?? String(cause)}`, { cause });
		this.name = "ReadBackUnavailableError";
	}
}

// Raised before a file when this worker no longer owns the job.
class JobNotRunningError extends Error
{
	constructor()
	{
		super("The archive job is no longer running (ended elsewhere); stopping");
		this.name = "JobNotRunningError";
	}
}

/**
 * Rejects with a DbTimeoutError when promise has not settled within ms. A
 * query cannot be cancelled from here, so onLate (if given) is called with
 * (err, value) when it settles after the timeout, to clean up after it.
 *
 * @template T
 * @param {Promise<T>} promise
 * @param {string} label Used in the error message.
 * @param {number} ms
 * @param {(err: unknown, value?: T) => void} [onLate]
 * @returns {Promise<T>}
 */
export function withTimeout(promise, label, ms, onLate)
{
	let timer;
	let timedOut = false;

	const timeout = new Promise((resolve, reject) =>
	{
		timer = setTimeout(() =>
		{
			timedOut = true;
			reject(new DbTimeoutError(label, ms));
		}, ms);
	});

	// Also keeps a late rejection from going unhandled.
	Promise.resolve(promise).then(
		(value) =>
		{
			if (timedOut)
			{
				onLate?.(null, value);
			}
		},
		(err) =>
		{
			if (timedOut)
			{
				onLate?.(err);
			}
		},
	);

	return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function isNotFound(err)
{
	return (
		err?.name === "NoSuchKey" ||
		err?.name === "NotFound" ||
		err?.$metadata?.httpStatusCode === 404
	);
}

// A conditional write was refused because the object is no longer the version
// that was checked (412), or because it is gone (404).
function isConcurrentChange(err)
{
	return isPreconditionFailed(err) || isNotFound(err);
}

// A failure to read an object that says nothing about its bytes: an S3 5xx or
// throttling answer, an error the SDK marks retryable, a request timeout, or a
// dropped connection. Checksum, size and decoder errors are not transient
// (decodeAndHash wraps anything from the decoder stage in an ArchiveFileError).
function isTransientReadError(err)
{
	if (err instanceof ArchiveFileError || err instanceof ChecksumMismatchError)
	{
		return false;
	}

	// S3 answers RequestTimeout with a 400, so it goes before the status check.
	if (err?.$retryable || err?.name === "RequestTimeout" || err?.name === "TimeoutError")
	{
		return true;
	}

	const status = err?.$metadata?.httpStatusCode;

	if (typeof status === "number")
	{
		return status >= 500 || status === 429;
	}

	return TRANSIENT_NETWORK_CODES.has(err?.code);
}

function parseSize(value)
{
	if (typeof value !== "string" || !SIZE_PATTERN.test(value))
	{
		return null;
	}

	const size = Number(value);

	return Number.isSafeInteger(size) ? size : null;
}

// Pipes source (through any transforms) into nothing, hashing the result.
async function hashStream(source, ...transforms)
{
	const hash = createHash("sha256");
	let size = 0;

	await pipeline(
		source,
		...transforms,
		new Writable({
			write(chunk, encoding, callback)
			{
				hash.update(chunk);
				size += chunk.length;
				callback();
			},
		}),
	);

	return { sha256: hash.digest("hex"), size };
}

// hashStream(source, decoder) for a stored object, where it matters which
// stage failed first. Only a failure the source raised (an error, or closing
// before it ended) before the decoder did anything is passed on as is, for
// isTransientReadError to judge. A failure after the source delivered every
// byte, or one that started at the decoder (an error, or ending or closing
// while the source still had bytes), throws StoredArchiveDecodeError: it is
// about the archive's bytes, also when it surfaces as a premature close.
async function decodeAndHash(source, method)
{
	const decoder = createDecompressStream(method);
	let firstStage = null;
	const mark = (stage) => () =>
	{
		firstStage ??= stage;
	};

	source.once("error", mark("source"));
	source.once("end", mark("bytes"));
	source.once("close", mark("source"));
	decoder.once("error", mark("decoder"));
	decoder.once("end", mark("decoder"));
	decoder.once("close", mark("decoder"));

	try
	{
		return await hashStream(source, decoder);
	}
	catch (err)
	{
		if (firstStage === "bytes" || firstStage === "decoder")
		{
			throw new StoredArchiveDecodeError(err);
		}

		throw err;
	}
}

// Writes source to filePath, hashing the bytes on the way. onBytes(size) is
// called with the running total after every chunk. The file is created
// owner-only and exclusively ("wx"), so nothing planted at the path in a
// shared temp directory is followed or reused.
async function saveToFile(source, filePath, onBytes)
{
	const hash = createHash("sha256");
	let size = 0;

	await pipeline(
		source,
		new Transform({
			transform(chunk, encoding, callback)
			{
				hash.update(chunk);
				size += chunk.length;
				onBytes?.(size);
				callback(null, chunk);
			},
		}),
		createWriteStream(filePath, { flags: "wx", mode: PRIVATE_FILE_MODE }),
	);

	return { sha256: hash.digest("hex"), size };
}

// Like getFile, plus the ETag of the version this GET returned, so the later
// If-Match can be tied to the bytes that were actually downloaded.
async function getOrderFile(s3, fileId)
{
	const response = await s3.send(
		new GetObjectCommand({
			Bucket: ORDER_FILES_BUCKET,
			Key: fileId,
		}),
	);

	return {
		body: response.Body,
		contentLength: response.ContentLength,
		contentType: response.ContentType,
		metadata: response.Metadata,
		etag: response.ETag ?? null,
	};
}

function headOrderFile(s3, fileId)
{
	return s3.send(
		new HeadObjectCommand({
			Bucket: ORDER_FILES_BUCKET,
			Key: fileId,
		}),
	);
}

function deleteOrderFileObject(s3, fileId)
{
	return s3.send(
		new DeleteObjectCommand({
			Bucket: ORDER_FILES_BUCKET,
			Key: fileId,
		}),
	);
}

// Replaces the object only while it still has the ETag ifMatch. lib-storage
// passes IfMatch on to PutObject (single part) and to CompleteMultipartUpload
// (files above PART_SIZE_BYTES), so the replacement is refused with 412
// PreconditionFailed when the object was replaced meanwhile, or with 404 when
// it was deleted (e.g. together with its order). MinIO releases without
// conditional-write support ignore If-Match, which degrades to an
// unconditional replace (the behaviour before this check existed).
//
// A metadata-only copy (rename, checksum backfill) keeps the content ETag, so
// If-Match does not catch it: a rename that lands between the caller's last
// HEAD and this write is lost. archiveOrderFile takes that HEAD right before
// calling this, after its journal row exists, and renameOrderFile refuses
// while the row exists; renames that come after the write re-read the
// metadata (updateOrderFileMetadata).
//
// Resolves to the ETag of the written object.
async function uploadOrderFile(s3, fileId, filePath, { contentType, metadata, ifMatch })
{
	const body = createReadStream(filePath);
	let upload = null;

	try
	{
		upload = new Upload({
			client: s3,
			params: {
				Bucket: ORDER_FILES_BUCKET,
				Key: fileId,
				Body: body,
				...(contentType ? { ContentType: contentType } : {}),
				...(ifMatch ? { IfMatch: ifMatch } : {}),
				Metadata: metadata,
			},
			queueSize: 1,
			partSize: PART_SIZE_BYTES,
			leavePartsOnError: false,
		});

		const result = await upload.done();

		return result?.ETag ?? null;
	}
	catch (err)
	{
		// lib-storage does not abort the multipart upload when its completion
		// is refused, which would leave the parts behind.
		if (upload?.uploadId)
		{
			await s3.send(
				new AbortMultipartUploadCommand({
					Bucket: ORDER_FILES_BUCKET,
					Key: fileId,
					UploadId: upload.uploadId,
				}),
			).catch(() => undefined);
		}

		throw err;
	}
	finally
	{
		// A failed upload (or a constructor that threw) can leave the stream
		// half read or never read; close its descriptor now.
		body.destroy();
	}
}

async function tightenIfExists(filePath)
{
	try
	{
		await chmod(filePath, PRIVATE_FILE_MODE);
	}
	catch (err)
	{
		if (err?.code !== "ENOENT")
		{
			throw err;
		}
	}
}

// Copies the verified original out of the temp directory (which is often
// ephemeral in containers) when it is the only good copy left, next to a JSON
// file with what is needed to put it back. Resolves to the copy's path.
async function saveForRecovery({ fileId, originalPath, contentType, metadata, original, reason })
{
	const dir = recoveryDir();
	const { filePath, infoPath } = recoveryPaths(fileId);

	await mkdir(dir, { recursive: true, mode: PRIVATE_DIR_MODE });

	// mkdir's mode only applies to a folder it creates, so an existing one is
	// tightened here too. A folder we cannot chmod (owned by someone else) still
	// takes the copy: the files below are owner-only, and failing here would
	// leave the ephemeral temp original as the only copy.
	try
	{
		await chmod(dir, PRIVATE_DIR_MODE);
	}
	catch (err)
	{
		log.warn(`Could not make ${dir} owner-only (${err.message}); its files are still owner-only`);
	}

	// A copy left by an earlier save keeps its mode when overwritten, so it is
	// made owner-only before the new bytes go in, and again afterwards.
	await tightenIfExists(filePath);
	await tightenIfExists(infoPath);
	await copyFile(originalPath, filePath);
	await chmod(filePath, PRIVATE_FILE_MODE);
	await writeFile(
		infoPath,
		JSON.stringify(
			{
				fileId,
				bucket: ORDER_FILES_BUCKET,
				contentType: contentType ?? null,
				metadata,
				sha256: original.sha256,
				size: original.size,
				savedAt: new Date().toISOString(),
				reason,
			},
			null,
			"\t",
		),
		{ mode: PRIVATE_FILE_MODE },
	);
	// writeFile's mode, too, only applies when it creates the file.
	await chmod(infoPath, PRIVATE_FILE_MODE);

	return filePath;
}

// Reads the stored object back and checks that it decompresses to the original.
// Throws ChecksumMismatchError when it decompresses to different bytes.
async function verifyStoredObject(s3, fileId, candidate, original)
{
	const stored = await getFile(s3, ORDER_FILES_BUCKET, fileId);

	if (
		stored.contentLength !== candidate.size ||
		stored.metadata?.[ARCHIVE_META.method] !== candidate.method
	)
	{
		stored.body?.destroy?.();
		throw new ArchiveFileError("Stored object does not match the uploaded archive");
	}

	if (typeof stored.body?.once !== "function")
	{
		throw new ArchiveFileError("Stored object read back without a readable body");
	}

	const roundTrip = await decodeAndHash(stored.body, candidate.method);

	assertChecksum(fileId, original, roundTrip, `stored ${candidate.method} archive read back`);
}

// verifyStoredObject, retried when the object could not be read at all.
// Throws ReadBackUnavailableError when every attempt failed that way: the
// archive's bytes were never judged, so the caller must not restore over it.
async function readBackStoredObject(s3, fileId, candidate, original)
{
	for (let attempt = 1; ; attempt++)
	{
		try
		{
			await verifyStoredObject(s3, fileId, candidate, original);
			return;
		}
		catch (err)
		{
			if (!isTransientReadError(err))
			{
				throw err;
			}

			if (attempt >= READBACK_ATTEMPTS)
			{
				throw new ReadBackUnavailableError(err);
			}

			log.warn(`Read-back of file ${fileId} could not read the object (attempt ${attempt}/${READBACK_ATTEMPTS}): ${err.message}`);
		}
	}
}

// updateOrderFileMetadata, but only on the object version expectedEtag. That
// helper does its own HEAD right before its copy and binds the copy to the
// HEAD's ETag (CopySourceIfMatch), so the client it gets here refuses with
// ObjectChangedError, before anything is written, when that HEAD (or the HEAD
// of a retry after a 412) shows any other ETag or none, and refuses any copy
// that is not bound to expectedEtag. Nothing is ever stamped on bytes other
// than the ones that were hashed.
function updateMetadataOfVersion(s3, fileId, expectedEtag, buildUpdate)
{
	const boundClient = {
		send: async (command, ...rest) =>
		{
			if (command instanceof CopyObjectCommand && command.input?.CopySourceIfMatch !== expectedEtag)
			{
				throw new ObjectChangedError();
			}

			const response = await s3.send(command, ...rest);

			if (command instanceof HeadObjectCommand && response?.ETag !== expectedEtag)
			{
				throw new ObjectChangedError();
			}

			return response;
		},
	};

	return updateOrderFileMetadata(boundClient, fileId, buildUpdate);
}

// Puts the verified original back over our archive, only while the object is
// still the version ifMatch (never over a newer write). Resolves to "restored",
// or to "gone" when the object was deleted meanwhile (an order deletion removes
// its objects before the row), so there is nothing to restore. Throws for any
// other failure, including 412, and without an ifMatch (an unconditional PUT
// could overwrite a newer write). Used after a failed read-back and by crash
// recovery.
async function restoreOriginal(s3, fileId, { originalPath, contentType, metadata, ifMatch })
{
	if (!ifMatch)
	{
		throw new ArchiveFileError("No ETag of our archive to bind the restore to; not restoring unconditionally");
	}

	try
	{
		await uploadOrderFile(s3, fileId, originalPath, { contentType, metadata, ifMatch });
	}
	catch (err)
	{
		if (isNotFound(err))
		{
			return "gone";
		}

		throw err;
	}

	return "restored";
}

// For a restore when the upload returned no ETag: the object's current ETag,
// but only while a HEAD still shows the archive this run wrote (same codec,
// size, original sha256 and archive time). Resolves to { etag }, or to
// { state: "gone" } / { state: "replaced" } when there is nothing of ours to
// restore over. Throws when the HEAD fails or our archive has no ETag.
async function findOwnArchive(s3, fileId, { method, size, sha256, archivedAt })
{
	let head;

	try
	{
		head = await headOrderFile(s3, fileId);
	}
	catch (err)
	{
		if (isNotFound(err))
		{
			return { state: "gone" };
		}

		throw err;
	}

	const metadata = head.Metadata ?? {};
	const ours =
		metadata[ARCHIVE_META.method] === method &&
		metadata[ARCHIVE_META.sha256] === sha256 &&
		metadata[ARCHIVE_META.archivedAt] === archivedAt &&
		head.ContentLength === size;

	if (!ours)
	{
		return { state: "replaced" };
	}

	if (!head.ETag)
	{
		throw new ArchiveFileError("Neither the upload nor a HEAD returned an ETag for our archive");
	}

	return { etag: head.ETag };
}

// The metadata the original had, rebuilt from our archive's metadata: the
// archive keys go, the original's sha256 stays.
function originalMetadataFrom(archiveMetadata, sha256)
{
	const metadata = { ...archiveMetadata, [ARCHIVE_META.sha256]: sha256 };

	delete metadata[ARCHIVE_META.method];
	delete metadata[ARCHIVE_META.originalSize];
	delete metadata[ARCHIVE_META.archivedAt];
	delete metadata[ENCODER_META_KEY];

	return metadata;
}

function failedResult(err)
{
	return {
		outcome: FILE_OUTCOMES.failed,
		method: null,
		originalSize: null,
		storedSize: null,
		error: err,
	};
}

function alreadyArchivedResult(metadata, storedSize)
{
	const method = metadata?.[ARCHIVE_META.method];

	return {
		outcome: FILE_OUTCOMES.alreadyArchived,
		method,
		originalSize: parseSize(metadata?.[ARCHIVE_META.originalSize]) ?? storedSize ?? null,
		storedSize: storedSize ?? null,
	};
}

function changedResult(originalSize)
{
	return {
		outcome: FILE_OUTCOMES.changed,
		method: null,
		originalSize,
		storedSize: null,
	};
}

// Archives one order file in place. The original bytes are replaced only after
// the compressed result has been decompressed and its sha256 matches the
// original, and only while the object is still the version that was checked
// (If-Match); otherwise the outcome is "changed" and nothing is written. After
// the upload the stored object is read back and checked again, and the
// original is restored (again conditionally) if that check fails.
//
// isStillAttached() is called after a replacement upload, and before a
// restore; when it resolves to false (the order was deleted meanwhile) the
// object is deleted so no orphan is left. Throws when the file cannot be
// archived; the object is then unchanged (or, at worst, replaced by a verified
// archive of the same bytes). If neither the read-back nor the restore works,
// the verified original is kept in ARCHIVER_RECOVERY_DIR.
//
// Checksums: the sha256 of the original is computed while it is downloaded,
// checked against the stored ARCHIVE_META.sha256 (if any) and written to the
// archive's metadata. The compressed result is decompressed and hashed before
// anything is written, and the stored object again after the upload. Any
// mismatch throws ChecksumMismatchError (expected/actual on the error; for the
// read-back it is the cause of the ArchiveFileError), and the file counts as
// failed.
//
// compress(srcPath, { minSavingsRatio, onProgress }) has the nativeCompressBest
// contract: { method, path, size, encoder? } or null. onProgress receives
// { phase, bytesDone, bytesTotal } with phase download, compress-zstd,
// compress-br, verify, upload or readback; it is advisory and never throws
// into the archiving.
//
// Crash journal (phases-bugfix/phase4.md 9.2): an archive_pending_verify row is
// opened before the replacing upload (no row, no upload) and closed once the
// outcome is settled: read-back passed, our write was refused, the original
// was restored, the orphan was deleted, or the object is gone. Any other upload
// error keeps the row, because the outcome is unknown. When the restore fails
// too and the original was saved to ARCHIVER_RECOVERY_DIR, the row becomes
// 'needs_attention'. While a row is left the temp original is kept (crash
// recovery restores from it); it is removed only once no row is left.
/**
 * @param {object} options
 * @param {object} options.s3 S3 client.
 * @param {string} options.fileId UUID of the order file (its S3 key).
 * @param {{ sql: Function, jobId: string | number, timeoutMs: number }} options.journal
 *   Pool client for the crash journal, the job writing it, and the bound for
 *   each journal statement.
 * @param {(srcPath: string, options: { minSavingsRatio: number, onProgress: Function }) => Promise<{ method: string, path: string, size: number, encoder?: string | null } | null>} options.compress
 * @param {() => Promise<boolean>} [options.isStillAttached]
 * @param {number} [options.minSavingsRatio]
 * @param {() => Date} [options.now]
 * @param {(progress: { phase: string, bytesDone: number, bytesTotal: number }) => void} [options.onProgress]
 * @returns {Promise<{ outcome: string, method: string | null, originalSize: number | null, storedSize: number | null }>}
 */
export async function archiveOrderFile({
	s3,
	fileId,
	journal,
	compress,
	isStillAttached = async () => true,
	minSavingsRatio = MIN_SAVINGS_RATIO,
	now = () => new Date(),
	onProgress,
})
{
	if (!isUuid(fileId))
	{
		throw new TypeError("fileId must be a UUID");
	}

	assertJournal(journal);

	if (typeof compress !== "function")
	{
		throw new TypeError("compress must be a function");
	}

	if (onProgress !== undefined && typeof onProgress !== "function")
	{
		throw new TypeError("onProgress must be a function");
	}

	const report = (phase, bytesDone, bytesTotal) =>
	{
		try
		{
			onProgress?.({ phase, bytesDone, bytesTotal: bytesTotal ?? 0 });
		}
		catch
		{
			// Progress is advisory; a failing listener must not fail the file.
		}
	};
	const originalPath = createTempFilePath();
	let candidate = null;
	// True while this file has a journal row: the temp original must stay.
	let journalOpen = false;
	const journalQuery = (query, label, onLate) => withTimeout(query, label, journal.timeoutMs, onLate);
	// Deletes the row. Resolves to false (and logs) when that failed; the row
	// and the temp original are then left for crash recovery and the sweep.
	const closeJournal = async () =>
	{
		try
		{
			await journalQuery(deletePendingVerify(journal.sql, fileId), "Clearing the crash journal");
			journalOpen = false;
			return true;
		}
		catch (err)
		{
			log.warn(`Could not clear the crash journal row of file ${fileId}; recovery will handle it: ${err.message}`);
			return false;
		}
	};

	try
	{
		let head;

		try
		{
			head = await headOrderFile(s3, fileId);
		}
		catch (err)
		{
			// Deleted after its candidate was selected: nothing to archive.
			if (isNotFound(err))
			{
				log.info(`File ${fileId} was deleted before archiving; skipped`);
				return changedResult(0);
			}

			throw err;
		}

		if (head.Metadata?.[ARCHIVE_META.method])
		{
			return alreadyArchivedResult(head.Metadata, head.ContentLength);
		}

		let file;

		try
		{
			file = await getOrderFile(s3, fileId);
		}
		catch (err)
		{
			if (isNotFound(err))
			{
				log.info(`File ${fileId} was deleted before archiving; skipped`);
				return changedResult(0);
			}

			throw err;
		}

		if (file.metadata?.[ARCHIVE_META.method])
		{
			file.body?.destroy?.();
			return alreadyArchivedResult(file.metadata, file.contentLength);
		}

		if (!file.etag)
		{
			// The upload's If-Match must name the version these bytes came from.
			file.body?.destroy?.();
			throw new ArchiveFileError(`GET of ${fileId} returned no ETag; original left untouched`);
		}

		report("download", 0, file.contentLength);

		const original = await saveToFile(file.body, originalPath, (bytes) =>
		{
			report("download", bytes, file.contentLength);
		});

		if (file.contentLength !== undefined && original.size !== file.contentLength)
		{
			throw new ArchiveFileError(`Read ${original.size} of ${file.contentLength} bytes`);
		}

		const storedChecksum = file.metadata?.[ARCHIVE_META.sha256];

		if (storedChecksum)
		{
			if (!isSha256Hex(storedChecksum))
			{
				throw new ArchiveFileError(`Stored sha256 of ${fileId} is malformed; original left untouched`);
			}

			// The bytes no longer match what was uploaded: archiving them would
			// make the corruption permanent.
			assertChecksum(fileId, { sha256: storedChecksum }, original, "stored sha256 vs. content; original left untouched");
		}

		const archivedAt = now().toISOString();
		const archiveMetadata = (method) => ({
			[ARCHIVE_META.sha256]: original.sha256,
			[ARCHIVE_META.method]: method,
			[ARCHIVE_META.originalSize]: String(original.size),
			[ARCHIVE_META.archivedAt]: archivedAt,
		});

		report("compress-zstd", 0, original.size);

		candidate = await compress(originalPath, {
			minSavingsRatio,
			// The adapter reports its codec ("zstd" or "br") as the phase.
			onProgress: ({ phase, bytesDone, bytesTotal }) =>
			{
				report(`compress-${phase}`, bytesDone, bytesTotal);
			},
		});

		if (!candidate)
		{
			let updated;

			try
			{
				// Bound to file.etag: the sha256 stamped here is that of the
				// bytes downloaded above, so a replacement since the GET (even
				// one of the same size without a stored sha256) writes nothing.
				updated = await updateMetadataOfVersion(s3, fileId, file.etag, (current) =>
				{
					if (current[ARCHIVE_META.method])
					{
						return null;
					}

					const currentChecksum = current[ARCHIVE_META.sha256];

					if (currentChecksum && currentChecksum !== original.sha256)
					{
						throw new ObjectChangedError();
					}

					return archiveMetadata(COMPRESSION_METHODS.identity);
				});
			}
			catch (err)
			{
				if (err instanceof ObjectChangedError || isConcurrentChange(err))
				{
					log.info(`File ${fileId} changed or was deleted during archiving; left for the next run`);
					return changedResult(original.size);
				}

				throw err;
			}

			if (!updated)
			{
				// Another writer set a compression marker in the meantime.
				return {
					outcome: FILE_OUTCOMES.alreadyArchived,
					method: null,
					originalSize: original.size,
					storedSize: null,
				};
			}

			return {
				outcome: FILE_OUTCOMES.incompressible,
				method: COMPRESSION_METHODS.identity,
				originalSize: original.size,
				storedSize: original.size,
			};
		}

		// Never upload anything that does not decompress to the original bytes.
		// A throw here (mismatch or a decoder error) leaves the object untouched.
		report("verify", 0, original.size);

		const verified = await hashStream(
			createReadStream(candidate.path),
			createDecompressStream(candidate.method),
		);

		assertChecksum(fileId, original, verified, `${candidate.method} round trip; original left untouched`);

		// Checks the object before the journal row is written; the metadata
		// for the upload is read again once the row exists (below).
		let latest;

		try
		{
			latest = await headOrderFile(s3, fileId);
		}
		catch (err)
		{
			if (isNotFound(err))
			{
				log.info(`File ${fileId} was deleted during archiving; left for the next run`);
				return changedResult(original.size);
			}

			throw err;
		}

		if (latest.Metadata?.[ARCHIVE_META.method])
		{
			return alreadyArchivedResult(latest.Metadata, latest.ContentLength);
		}

		const latestChecksum = latest.Metadata?.[ARCHIVE_META.sha256];

		if (
			latest.ContentLength !== original.size ||
			(latestChecksum && latestChecksum !== original.sha256)
		)
		{
			log.info(`File ${fileId} changed during archiving; left for the next run`);
			return changedResult(original.size);
		}

		const orphanedResult = {
			outcome: FILE_OUTCOMES.orphaned,
			method: candidate.method,
			originalSize: original.size,
			storedSize: candidate.size,
		};

		if (!latest.ETag)
		{
			// Without an ETag there is neither an If-Match nor a journal row.
			throw new ArchiveFileError(`HEAD of ${fileId} returned no ETag; original left untouched`);
		}

		// The bytes downloaded and verified above are the version file.etag.
		// Any other ETag now means the content was replaced since the GET, also
		// when the size matches and no stored sha256 could tell.
		if (latest.ETag !== file.etag)
		{
			log.info(`File ${fileId} was replaced during archiving; left for the next run`);
			return changedResult(original.size);
		}

		// 9.2 step 1: no journal row, no upload.
		try
		{
			await journalQuery(insertPendingVerify(journal.sql, {
				fileId,
				jobId: journal.jobId,
				method: candidate.method,
				originalSha256: original.sha256,
				originalSize: original.size,
				storedSize: candidate.size,
				preUploadEtag: latest.ETag,
				originalPath,
			}), "Writing the crash journal", (lateErr) =>
			{
				// The insert landed after it had timed out. Nothing was uploaded
				// for that row, so it goes again instead of blocking the order
				// until the next job-start recovery.
				if (!lateErr)
				{
					removeLateJournalRow(journal, fileId, originalPath);
				}
			});
		}
		catch (err)
		{
			throw new ArchiveFileError(
				`Could not write the crash journal row; original left untouched: ${err.message}`,
				{ cause: err },
			);
		}

		journalOpen = true;

		// The metadata the upload writes (and a restore would write) is read
		// here, after the journal row exists and right before the upload
		// (review 2026-11-20, item 3). A metadata-only rename keeps the ETag, so
		// If-Match cannot catch one; instead renameOrderFile refuses while the
		// row exists, and a rename that came earlier is in this HEAD. What is
		// left is a rename whose journal check ran just before the insert above
		// and whose copy lands after this HEAD: it is overwritten by the upload.
		// That window is one journal query plus one S3 round trip on the rename
		// side (see renameOrderFile). The restore after a failed read-back
		// reuses this metadata: the row is still open then, so no rename can
		// have landed on our archive since.
		let fresh;

		try
		{
			fresh = await headOrderFile(s3, fileId);
		}
		catch (err)
		{
			// Nothing was written for this row.
			await closeJournal();

			if (isNotFound(err))
			{
				log.info(`File ${fileId} was deleted before its archive was written; left for the next run`);
				return changedResult(original.size);
			}

			throw err;
		}

		if (fresh.ETag !== file.etag)
		{
			await closeJournal();
			log.info(`File ${fileId} was replaced before its archive was written; left for the next run`);
			return changedResult(original.size);
		}

		if (fresh.Metadata?.[ARCHIVE_META.method])
		{
			await closeJournal();
			return alreadyArchivedResult(fresh.Metadata, fresh.ContentLength);
		}

		const contentType = fresh.ContentType ?? file.contentType;
		const originalMetadata = { ...fresh.Metadata, [ARCHIVE_META.sha256]: original.sha256 };
		const storedMetadata = {
			...fresh.Metadata,
			...archiveMetadata(candidate.method),
		};

		// Never carry over an encoder key that describes some other write.
		delete storedMetadata[ENCODER_META_KEY];

		if (typeof candidate.encoder === "string" && ENCODER_PATTERN.test(candidate.encoder))
		{
			storedMetadata[ENCODER_META_KEY] = candidate.encoder;
		}

		let storedEtag;

		report("upload", 0, candidate.size);

		try
		{
			// Bound to the version checked above: a replace or delete since then
			// (e.g. the order being deleted) refuses the write and leaves the
			// object as the other writer left it.
			storedEtag = await uploadOrderFile(s3, fileId, candidate.path, {
				contentType,
				metadata: storedMetadata,
				ifMatch: fresh.ETag,
			});
		}
		catch (err)
		{
			if (isConcurrentChange(err))
			{
				// Nothing was written.
				await closeJournal();
				log.info(`File ${fileId} changed or was deleted before its archive was written; left for the next run`);
				return changedResult(original.size);
			}

			// Unknown outcome: the row stays, and recovery decides from a HEAD.
			throw err;
		}

		try
		{
			await journalQuery(markPendingUploaded(journal.sql, fileId, storedEtag), "Updating the crash journal");
		}
		catch (err)
		{
			// The row still says 'uploading'; recovery treats both states alike.
			log.warn(`Could not mark the crash journal row of file ${fileId} uploaded: ${err.message}`);
		}

		report("readback", 0, candidate.size);

		try
		{
			await readBackStoredObject(s3, fileId, candidate, original);
		}
		catch (verifyErr)
		{
			// The object could not be read at all, so nothing says the archive
			// is bad: no restore. The row and the temp original stay, and crash
			// recovery reads it back again at the next job start.
			if (verifyErr instanceof ReadBackUnavailableError)
			{
				throw verifyErr;
			}

			// When the read-back failed because the order (and its objects) was
			// deleted meanwhile, restoring would bring back a file no order owns.
			let attached = true;

			try
			{
				attached = await isStillAttached();
			}
			catch (err)
			{
				log.warn(`Could not check whether file ${fileId} is still on its order: ${err.message}`);
			}

			if (!attached)
			{
				await deleteOrderFileObject(s3, fileId);
				log.info(`File ${fileId} was removed from its order during archiving; deleted the object`);
				await closeJournal();

				return orphanedResult;
			}

			log.error(`Archived file ${fileId} failed read-back verification, restoring the original`, verifyErr);

			let restored;

			try
			{
				// Only over our own archive, never over a newer write. An upload
				// that returned no ETag is bound to the one a HEAD shows now, and
				// only while that HEAD still shows this archive.
				const target = storedEtag
					? { etag: storedEtag }
					: await findOwnArchive(s3, fileId, { method: candidate.method, size: candidate.size, sha256: original.sha256, archivedAt });

				restored = target.etag
					? await restoreOriginal(s3, fileId, {
						originalPath,
						contentType,
						metadata: originalMetadata,
						ifMatch: target.etag,
					})
					: target.state;
			}
			catch (restoreErr)
			{
				// The verified original on disk may now be the only good copy.
				const reason = `Read-back: ${verifyErr.message}; restore: ${restoreErr.message}`;
				let savedTo = null;

				try
				{
					savedTo = await saveForRecovery({
						fileId,
						originalPath,
						contentType,
						metadata: originalMetadata,
						original,
						reason,
					});
				}
				catch (saveErr)
				{
					// The row stays as it is, so recovery tries again from the
					// temp original, which is kept while the row exists.
					log.error(`Could not save file ${fileId} to ${recoveryDir()}`, saveErr);
				}

				if (savedTo)
				{
					await flagNeedsAttention(journal, fileId, `Original saved to ${savedTo}. ${reason}`);
				}

				const location = savedTo ?? originalPath;

				log.error(`Could not restore file ${fileId}; original kept at ${location}`, restoreErr);

				throw new ArchiveFileError(
					`Read-back verification and restore failed; original kept at ${location}`,
					{ cause: verifyErr },
				);
			}

			await closeJournal();

			if (restored === "gone")
			{
				log.info(`File ${fileId} was deleted during archiving; nothing to restore`);
				return changedResult(original.size);
			}

			if (restored === "replaced")
			{
				log.info(`File ${fileId} was replaced by a newer write after its archive was uploaded; nothing to restore`);
				return changedResult(original.size);
			}

			throw new ArchiveFileError(
				`Read-back verification failed, original restored: ${verifyErr.message}`,
				{ cause: verifyErr },
			);
		}

		let attached = true;

		try
		{
			attached = await isStillAttached();
		}
		catch (err)
		{
			// Like the check before a restore: an unknown answer keeps the
			// verified archive. The order is only marked when its files match.
			log.warn(`Could not check whether file ${fileId} is still on its order: ${err.message}`);
		}

		if (!attached)
		{
			await deleteOrderFileObject(s3, fileId);
			log.info(`File ${fileId} was removed from its order during archiving; deleted the object`);
			await closeJournal();

			return orphanedResult;
		}

		// The order must not be marked while the file still has a row, so a
		// row that could not be cleared fails the file; recovery clears it at
		// the next job start.
		if (!(await closeJournal()))
		{
			throw new ArchiveFileError("Archive verified, but its crash journal row could not be cleared");
		}

		return {
			outcome: FILE_OUTCOMES.compressed,
			method: candidate.method,
			originalSize: original.size,
			storedSize: candidate.size,
		};
	}
	finally
	{
		await removeTempFile(candidate?.path).catch((err) =>
			log.warn(`Could not remove temp file ${candidate?.path}: ${err.message}`));

		if (journalOpen)
		{
			log.info(`File ${fileId} still has a crash journal row; its original is kept at ${originalPath}`);
		}
		else
		{
			await removeTempFile(originalPath).catch((err) =>
				log.warn(`Could not remove temp file ${originalPath}: ${err.message}`));
		}
	}
}

// ---- Database access (all short statements; statement_timeout is 15 s) ----

// True while the file is on the order and no deletion of the order is running
// (orders.deleting_at younger than DELETION_STALE_AFTER_MS): a file of an order
// being deleted counts as no longer attached, so the archiver does not replace it.
export async function isFileOnOrder(sql, orderId, fileId)
{
	const rows = await sql`
		SELECT 1
		FROM orders
		WHERE order_id = ${orderId}
			AND ${fileId} = ANY(files)
			AND (orders.deleting_at IS NULL OR orders.deleting_at < now() - ${DELETION_STALE_INTERVAL}::interval)
	`;

	return rows.length > 0;
}

// Only marks the order when its files are still the ones that were archived;
// an order edited meanwhile is left for the next run. An order with a file
// that still has a crash journal row (one recovery could not settle, or a
// 'needs_attention' row) is not marked either (phase4.md 9.1), nor is one whose
// deletion is running (orders.deleting_at younger than DELETION_STALE_AFTER_MS;
// an expired marker does not count).
export async function markOrderArchived(sql, orderId, files)
{
	const rows = await sql`
		UPDATE orders
		SET archived_at = now()
		WHERE order_id = ${orderId}
			AND files IS NOT DISTINCT FROM ${files}
			AND archived_at IS NULL
			AND (orders.deleting_at IS NULL OR orders.deleting_at < now() - ${DELETION_STALE_INTERVAL}::interval)
			AND NOT EXISTS (
				SELECT 1
				FROM archive_pending_verify
				WHERE archive_pending_verify.file_id = ANY(orders.files::text[])
			)
		RETURNING order_id
	`;

	return rows.length > 0;
}

// The lock lives on its own one-connection client, never on a connection of the
// shared pool: a session lock must end with its session, and postgres.js 3.4.7
// breaks the pool when a reserved connection whose socket already closed is
// released into it. idle_timeout and max_lifetime are off, so the session
// stays up through a long compression while the client sits idle.
function openArchiveLockClient()
{
	return createDbClient({ max: 1, idle_timeout: 0, max_lifetime: 0 });
}

// Closes a lock client and with it its session (and the lock). After
// timeoutMs, pending queries are dropped and the socket is destroyed. Never throws.
async function endLockClient(client, timeoutMs)
{
	try
	{
		await withTimeout(
			client.end({ timeout: Math.max(1, Math.ceil(timeoutMs / 1000)) }),
			"Closing the archive lock connection",
			timeoutMs + 1000,
		);
	}
	catch (err)
	{
		log.warn(`Could not close the archive lock connection: ${err.message}`);
	}
}

/**
 * Takes the archive advisory lock on a dedicated database connection. Session
 * locks live as long as their session, so the lock is held until
 * releaseArchiveLock closes that connection (or the process dies).
 *
 * @param {object} options
 * @param {number} options.timeoutMs Bound for connecting and for the lock query.
 * @param {() => Function & { end: Function }} [options.openClient] Creates the
 *   one-connection postgres.js client; tests pass a fake.
 * @returns {Promise<{ client: Function & { end: Function }, pid: number } | null>}
 *   The client holding the lock and its backend pid, or null when another
 *   session holds the lock.
 */
export async function acquireArchiveLock({ timeoutMs, openClient = openArchiveLockClient } = {})
{
	assertTimeout(timeoutMs);

	if (typeof openClient !== "function")
	{
		throw new TypeError("openClient must be a function");
	}

	const client = openClient();
	let row;

	try
	{
		// On a timeout the client is closed below, which ends its session, so a
		// lock taken by a query that lands late goes with it.
		[row] = await withTimeout(
			client`SELECT pg_backend_pid() AS pid, pg_try_advisory_lock(${ARCHIVE_LOCK_KEY}::bigint) AS locked`,
			"Taking the archive lock",
			timeoutMs,
		);
	}
	catch (err)
	{
		await endLockClient(client, timeoutMs);
		throw err;
	}

	if (row?.locked)
	{
		return { client, pid: row.pid };
	}

	await endLockClient(client, timeoutMs);

	return null;
}

// A session lock lives as long as its session. When the lock connection drops,
// the client's next query opens a new session, which no longer holds the lock
// (or does not settle at all). So the backend pid must still be the one that
// took the lock, and the query is bounded by timeoutMs. Session locks are
// re-entrant, so pg_try_advisory_lock succeeds while we hold the lock; it
// also catches a recycled pid in a session that does not hold it.
async function confirmArchiveLock(lock, timeoutMs)
{
	const [row] = await withTimeout(
		lock.client`SELECT pg_backend_pid() AS pid, pg_try_advisory_lock(${ARCHIVE_LOCK_KEY}::bigint) AS locked`,
		"Confirming the archive lock",
		timeoutMs,
	);

	if (row?.pid !== lock.pid)
	{
		throw new Error("Lost the database session holding the archive lock");
	}

	if (!row?.locked)
	{
		throw new Error("Lost the archive lock to another instance");
	}
}

/**
 * Releases the archive lock and closes its connection. Never throws. The
 * explicit unlock (which also drops the re-entrant holds taken by
 * confirmArchiveLock) is a courtesy: closing the session always releases the
 * lock, also when the unlock fails or the session is already gone. Nothing is
 * returned to the shared pool.
 *
 * @param {{ client: Function & { end: Function } }} lock From acquireArchiveLock.
 * @param {number} timeoutMs
 * @returns {Promise<void>}
 */
export async function releaseArchiveLock(lock, timeoutMs)
{
	try
	{
		await withTimeout(
			lock.client`SELECT pg_advisory_unlock_all()`,
			"Releasing the archive lock",
			timeoutMs,
		);
	}
	catch (err)
	{
		log.warn(`Could not release the archive lock: ${err.message}; closing its connection`);
	}

	await endLockClient(lock.client, timeoutMs);
}

// ---- Job state ----

function assertTimeout(timeoutMs)
{
	if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1)
	{
		throw new RangeError("timeoutMs must be a positive integer");
	}
}

function assertJobId(jobId)
{
	if (jobId === null || jobId === undefined || jobId === "")
	{
		throw new TypeError("jobId must identify the archive job");
	}
}

function assertJournal(journal)
{
	if (typeof journal?.sql !== "function")
	{
		throw new TypeError("journal.sql must be a postgres.js client");
	}

	assertJobId(journal.jobId);
	assertTimeout(journal.timeoutMs);
}

// Journal notes end up in the status panel; keep them bounded.
const MAX_NOTE_LENGTH = 2000;

// Hands a journal row to an operator ('needs_attention'). Resolves to false
// (and logs) when the update failed; the row then keeps its state and crash
// recovery looks at it again.
async function flagNeedsAttention(journal, fileId, note)
{
	try
	{
		await withTimeout(
			markPendingNeedsAttention(journal.sql, fileId, note.slice(0, MAX_NOTE_LENGTH)),
			"Flagging the crash journal row",
			journal.timeoutMs,
		);
	}
	catch (err)
	{
		log.warn(`Could not flag the crash journal row of file ${fileId} for attention: ${err.message}`);
		return false;
	}

	log.error(`File ${fileId} needs attention: ${note}`);
	return true;
}

// Removes a journal row whose insert landed after archiveOrderFile had already
// given up on it (no upload was made for it). Only that attempt's row, and only
// while still 'uploading'. Never throws; a failure leaves it to crash recovery,
// which finds the object never replaced and clears it.
function removeLateJournalRow(journal, fileId, originalPath)
{
	withTimeout(
		deletePendingVerifyAttempt(journal.sql, fileId, originalPath),
		"Removing a late crash journal row",
		journal.timeoutMs,
	).then(
		() => log.info(`Removed the crash journal row of file ${fileId} that was written after its insert timed out`),
		(err) => log.warn(`Could not remove the late crash journal row of file ${fileId}; recovery will clear it: ${err.message}`),
	);
}

/**
 * The job's mutable counters. The worker writes this object (plus
 * currentFile) to archive_jobs.progress.
 *
 * @param {object} [overrides]
 * @returns {object}
 */
export function createStatus(overrides = {})
{
	return {
		state: "idle",
		startedAt: null,
		finishedAt: null,
		triggeredBy: null,
		ordersTotal: 0,
		// Orders processed with no failed file (ordersArchived + ordersChanged).
		ordersDone: 0,
		ordersFailed: 0,
		// Orders marked archived / edited, deleted, or with a file changed
		// during the run (next run retries).
		ordersArchived: 0,
		ordersChanged: 0,
		filesCompressed: 0,
		// filesAlreadyArchived + filesIncompressible.
		filesSkipped: 0,
		filesAlreadyArchived: 0,
		filesIncompressible: 0,
		filesOrphaned: 0,
		// Replaced or deleted by someone else while being archived; left as is.
		filesChanged: 0,
		filesFailed: 0,
		// Only files this run compressed or found incompressible are counted;
		// files archived by an earlier run are not.
		bytesBefore: 0,
		bytesAfter: 0,
		lastError: null,
		...overrides,
	};
}

// fileId is only used in lastError for a failed result.
export function recordFileResult(status, result, fileId = null)
{
	switch (result.outcome)
	{
		case FILE_OUTCOMES.compressed:
			status.filesCompressed++;
			status.bytesBefore += result.originalSize;
			status.bytesAfter += result.storedSize;
			break;
		case FILE_OUTCOMES.incompressible:
			status.filesSkipped++;
			status.filesIncompressible++;
			status.bytesBefore += result.originalSize;
			status.bytesAfter += result.storedSize;
			break;
		case FILE_OUTCOMES.alreadyArchived:
			status.filesSkipped++;
			status.filesAlreadyArchived++;
			break;
		case FILE_OUTCOMES.orphaned:
			status.filesOrphaned++;
			break;
		case FILE_OUTCOMES.changed:
			status.filesChanged++;
			break;
		case FILE_OUTCOMES.failed:
		{
			const message = result.error?.message ?? String(result.error);

			status.filesFailed++;
			status.lastError = fileId ? `File ${fileId}: ${message}` : message;
			break;
		}
		default:
			break;
	}
}

// Calls a caller-supplied listener; a throwing listener never fails the job.
function notify(listener, event)
{
	try
	{
		listener?.(event);
	}
	catch (err)
	{
		log.warn(`Archive progress listener failed: ${err.message}`);
	}
}

// Resolves to true when it stopped early because shouldStop() said so; the
// order is then neither counted nor marked. confirmOwnership() runs before
// every file and before the order is marked, and throws (failing the job)
// once this worker no longer holds the lock or the job is no longer running.
async function archiveOrder({
	sql,
	s3,
	order,
	status,
	timeoutMs,
	journal,
	compress,
	shouldStop,
	onFileResult,
	confirmOwnership,
})
{
	const orderId = order.order_id;
	const files = Array.isArray(order.files) ? order.files : [];
	// Files with a crash journal row left (see selectArchiveCandidates).
	const journaled = new Set(Array.isArray(order.journaled_files) ? order.journaled_files : []);
	let failedFiles = 0;
	let changedFiles = 0;

	for (const fileId of files)
	{
		if (shouldStop())
		{
			return true;
		}

		let result;

		// Ids from orders.files become S3 keys and recovery file names. A
		// malformed one fails the file without reaching S3, and is not echoed.
		if (!isUuid(fileId))
		{
			result = failedResult(new TypeError(`Order ${orderId} has a file id that is not a UUID`));
			failedFiles++;
			recordFileResult(status, result);
			log.warn(`Order ${orderId} has a file id that is not a UUID; skipped`);
			notify(onFileResult, { orderId, fileId: null, result });
			continue;
		}

		// Its row would refuse the journal insert only after the whole
		// download and compression, so the file is not even started. It stays
		// failed (and the order unmarked) until recovery or an operator settles
		// the row.
		if (journaled.has(fileId))
		{
			result = failedResult(new ArchiveFileError("The file still has a crash journal row; skipped until it is settled"));
			failedFiles++;
			recordFileResult(status, result, fileId);
			log.warn(`File ${fileId} of order ${orderId} still has a crash journal row; skipped`);
			notify(onFileResult, { orderId, fileId, result });
			continue;
		}

		await confirmOwnership();

		try
		{
			result = await archiveOrderFile({
				s3,
				fileId,
				journal,
				compress,
				isStillAttached: () => withTimeout(
					isFileOnOrder(sql, orderId, fileId),
					"Checking the order's files",
					timeoutMs,
				),
				onProgress: (progress) =>
				{
					status.currentFile = progress;
				},
			});

			recordFileResult(status, result);

			if (result.outcome === FILE_OUTCOMES.changed)
			{
				changedFiles++;
			}
		}
		catch (err)
		{
			// Shutdown aborted the compressor: nothing was written, and the file
			// is simply not done. Not a failure, so no counter and no lastError.
			if (err?.name === "AbortError" && shouldStop())
			{
				status.currentFile = null;
				log.info(`File ${fileId} of order ${orderId} was stopped by shutdown; left for the next run`);
				return true;
			}

			failedFiles++;
			result = failedResult(err);
			recordFileResult(status, result, fileId);

			if (err instanceof ChecksumMismatchError)
			{
				log.error(`Checksum verification failed for file ${fileId} of order ${orderId}; source left untouched`, err);
			}
			else
			{
				log.warn(`Could not archive file ${fileId} of order ${orderId}: ${err.message}`);
			}
		}

		status.currentFile = null;
		notify(onFileResult, { orderId, fileId, result });
	}

	if (failedFiles > 0)
	{
		status.ordersFailed++;
		return false;
	}

	if (changedFiles > 0)
	{
		status.ordersDone++;
		status.ordersChanged++;
		log.info(`Order ${orderId} had ${changedFiles} file(s) changed during archiving; left for the next run`);
		return false;
	}

	await confirmOwnership();

	try
	{
		const marked = await withTimeout(
			markOrderArchived(sql, orderId, order.files),
			"Marking the order archived",
			timeoutMs,
		);

		status.ordersDone++;

		if (marked)
		{
			status.ordersArchived++;
		}
		else
		{
			status.ordersChanged++;
			log.info(`Order ${orderId} changed during archiving, or a file of it still has a crash journal row; left for the next run`);
		}
	}
	catch (err)
	{
		status.ordersFailed++;
		status.lastError = `Order ${orderId}: ${err.message}`;
		log.warn(`Could not mark order ${orderId} as archived: ${err.message}`);
	}

	return false;
}

/**
 * Runs one archive job: every candidate order, one file at a time, while
 * holding the archive lock. Before every file and before an order is marked,
 * the lock is confirmed and the job must still be "running"; otherwise the job
 * fails there. The caller owns the lock: it writes the job's final state and
 * then releases it, so the job row never looks abandoned while the lock is
 * still held. Files that still have a crash journal row are skipped (failed).
 *
 * Never throws for a failing job: the outcome is the resolved state, also set
 * on status.state together with status.finishedAt.
 * - "done": every candidate was handled (individual files may have failed).
 * - "failed": the job itself failed (candidate query, lock lost, job ended
 *   elsewhere); see status.lastError.
 * - "interrupted": shouldStop() cut the work short. The file in progress is
 *   finished first, unless the caller's compress rejects with an AbortError,
 *   which leaves that file uncounted. The current order is neither counted nor
 *   marked, and no further file starts. A stop after the last order is "done".
 *
 * status.currentFile holds { phase, bytesDone, bytesTotal } of the file in
 * progress (no id or name), and is null between files.
 *
 * Crash recovery (recoverPendingVerifications) must have run before this, so
 * no order is marked while one of its files still has a journal row.
 *
 * @param {object} options
 * @param {Function} options.sql postgres.js client.
 * @param {object | null} [options.s3] S3 client; the shared one when null.
 * @param {{ client: Function, pid: number }} options.lock From acquireArchiveLock.
 * @param {string | number} options.jobId The archive_jobs row; written to the crash journal.
 * @param {object} options.status From createStatus(); mutated in place.
 * @param {number} options.timeoutMs Bound for each database query.
 * @param {Function} options.compress See archiveOrderFile.
 * @param {() => boolean} [options.shouldStop] Checked before every order and every file.
 * @param {(event: { orderId: string | number, fileId: string | null, result: object }) => void} [options.onFileResult]
 *   Called after each file, once its result is in status. fileId is null for
 *   a malformed id.
 * @returns {Promise<"done" | "failed" | "interrupted">}
 */
export async function runArchiveJob({
	sql,
	s3: injectedS3 = null,
	lock,
	jobId,
	status,
	timeoutMs,
	compress,
	shouldStop = () => false,
	onFileResult,
})
{
	if (typeof sql !== "function")
	{
		throw new TypeError("sql must be a postgres.js client");
	}

	if (typeof lock?.client !== "function")
	{
		throw new TypeError("lock must come from acquireArchiveLock");
	}

	assertJobId(jobId);

	if (!status || typeof status !== "object")
	{
		throw new TypeError("status must come from createStatus");
	}

	assertTimeout(timeoutMs);

	if (typeof compress !== "function")
	{
		throw new TypeError("compress must be a function");
	}

	if (typeof shouldStop !== "function")
	{
		throw new TypeError("shouldStop must be a function");
	}

	if (onFileResult !== undefined && typeof onFileResult !== "function")
	{
		throw new TypeError("onFileResult must be a function");
	}

	let finalState = "done";
	// A worker whose lock session dropped, or whose job was ended by another
	// worker that took the lock over, must not start another file: that worker
	// is now archiving (and recovering) the same files.
	const confirmOwnership = async () =>
	{
		await confirmArchiveLock(lock, timeoutMs);

		const running = await withTimeout(
			isJobRunning({ jobId, sql }),
			"Checking the archive job",
			timeoutMs,
		);

		if (!running)
		{
			throw new JobNotRunningError();
		}
	};

	status.currentFile = null;

	try
	{
		const s3 = injectedS3 ?? await createS3Client();
		const orders = await withTimeout(
			selectArchiveCandidates(sql),
			"Selecting archive candidates",
			timeoutMs,
		);

		status.ordersTotal = orders.length;

		for (const order of orders)
		{
			if (shouldStop())
			{
				finalState = "interrupted";
				break;
			}

			const stopped = await archiveOrder({
				sql,
				s3,
				order,
				status,
				timeoutMs,
				journal: { sql, jobId, timeoutMs },
				compress,
				shouldStop,
				onFileResult,
				confirmOwnership,
			});

			if (stopped)
			{
				finalState = "interrupted";
				break;
			}
		}

	}
	catch (err)
	{
		finalState = "failed";
		status.lastError = err.message;
		log.error("Archive job failed", err);
	}

	status.currentFile = null;
	status.finishedAt = new Date().toISOString();
	status.state = finalState;

	return finalState;
}

// ---- Crash recovery (phases-bugfix/phase4.md 9.3 and 9.4) ----

// The journal row as recovery uses it, or null when a column is not what
// archiveOrderFile writes. bigint columns arrive as strings.
function parseJournalRow(row)
{
	const originalSize = parseSize(String(row?.original_size ?? ""));
	const storedSize = parseSize(String(row?.stored_size ?? ""));

	if (
		!isUuid(row?.file_id) ||
		!JOURNAL_METHODS.has(row.method) ||
		!isSha256Hex(row.original_sha256) ||
		originalSize === null ||
		storedSize === null ||
		typeof row.pre_upload_etag !== "string" ||
		typeof row.original_path !== "string"
	)
	{
		return null;
	}

	return {
		fileId: row.file_id,
		method: row.method,
		originalSha256: row.original_sha256,
		originalSize,
		storedSize,
		preUploadEtag: row.pre_upload_etag,
		originalPath: row.original_path,
	};
}

async function removeJournalOriginal(filePath, fileId)
{
	if (!isTempOriginal(filePath))
	{
		log.warn(`Crash journal row of file ${fileId} does not point at an archiver temp file; nothing removed`);
		return;
	}

	await removeTempFile(filePath).catch((err) =>
		log.warn(`Could not remove temp file ${filePath}: ${err.message}`));
}

// Re-hashes the kept original the way saveToFile hashed it on download and
// throws unless it is still the verified original.
async function assertKeptOriginal(entry)
{
	if (!isTempOriginal(entry.originalPath))
	{
		throw new ArchiveFileError("the journal path is not an archiver temp file");
	}

	const stats = await lstat(entry.originalPath);

	if (!stats.isFile())
	{
		throw new ArchiveFileError("the journal path is not a regular file");
	}

	const actual = await hashStream(createReadStream(entry.originalPath));

	assertChecksum(
		entry.fileId,
		{ sha256: entry.originalSha256, size: entry.originalSize },
		actual,
		"kept original re-hashed before restore",
	);
}

function isNoSuchUpload(err)
{
	return err?.name === "NoSuchUpload" || isNotFound(err);
}

// Aborts every multipart upload still open for exactly this key (the one a
// crashed replacing upload left behind). Resolves to how many were aborted.
async function abortMultipartUploads(s3, fileId)
{
	let keyMarker;
	let uploadIdMarker;
	let aborted = 0;

	for (let page = 0; page < MAX_MULTIPART_LIST_PAGES; page++)
	{
		const listing = await s3.send(
			new ListMultipartUploadsCommand({
				Bucket: ORDER_FILES_BUCKET,
				Prefix: fileId,
				...(keyMarker ? { KeyMarker: keyMarker } : {}),
				...(uploadIdMarker ? { UploadIdMarker: uploadIdMarker } : {}),
			}),
		);

		for (const upload of listing.Uploads ?? [])
		{
			if (upload.Key !== fileId || !upload.UploadId)
			{
				continue;
			}

			try
			{
				await s3.send(
					new AbortMultipartUploadCommand({
						Bucket: ORDER_FILES_BUCKET,
						Key: fileId,
						UploadId: upload.UploadId,
					}),
				);
				aborted++;
			}
			catch (err)
			{
				if (!isNoSuchUpload(err))
				{
					throw err;
				}
			}
		}

		if (!listing.IsTruncated || (!listing.NextKeyMarker && !listing.NextUploadIdMarker))
		{
			return aborted;
		}

		keyMarker = listing.NextKeyMarker;
		uploadIdMarker = listing.NextUploadIdMarker;
	}

	throw new ArchiveFileError(`More than ${MAX_MULTIPART_LIST_PAGES} pages of multipart uploads for file ${fileId}`);
}

// Our archive (or an identical one) is in place, but its read-back never
// finished: read it back now, and restore the kept original when that fails.
async function recoverStoredArchive({ sql, s3, entry, head, timeoutMs, discard })
{
	const { fileId } = entry;

	try
	{
		await readBackStoredObject(
			s3,
			fileId,
			{ method: entry.method, size: entry.storedSize },
			{ sha256: entry.originalSha256, size: entry.originalSize },
		);
	}
	catch (verifyErr)
	{
		// The object could not be read, so its bytes were never judged: the
		// row (and the kept original) stay for the next run.
		if (verifyErr instanceof ReadBackUnavailableError)
		{
			throw verifyErr;
		}

		const attached = await withTimeout(isFileOnAnyOrder(sql, fileId), "Checking the orders' files", timeoutMs);

		if (!attached)
		{
			await deleteOrderFileObject(s3, fileId);
			await discard("failed the read-back and is on no order; deleted the object");
			return "cleared";
		}

		const journal = { sql, timeoutMs };

		try
		{
			await assertKeptOriginal(entry);
		}
		catch (err)
		{
			const note = `No valid original at ${entry.originalPath} (${err.message}). Read-back: ${verifyErr.message}`;

			return (await flagNeedsAttention(journal, fileId, note)) ? "needsAttention" : "kept";
		}

		const metadata = originalMetadataFrom(head.Metadata, entry.originalSha256);
		let restored;

		try
		{
			restored = await restoreOriginal(s3, fileId, {
				originalPath: entry.originalPath,
				contentType: head.ContentType,
				metadata,
				// Only over the archive just checked, never over a newer write.
				ifMatch: head.ETag,
			});
		}
		catch (restoreErr)
		{
			const reason = `Read-back: ${verifyErr.message}; restore: ${restoreErr.message}`;
			let savedTo = null;

			try
			{
				savedTo = await saveForRecovery({
					fileId,
					originalPath: entry.originalPath,
					contentType: head.ContentType,
					metadata,
					original: { sha256: entry.originalSha256, size: entry.originalSize },
					reason,
				});
			}
			catch (saveErr)
			{
				log.error(`Could not save file ${fileId} to ${recoveryDir()}`, saveErr);
			}

			if (!savedTo)
			{
				// The temp original stays the only copy; the row stays as it is.
				log.error(`Recovery could not restore file ${fileId}; original kept at ${entry.originalPath}`, restoreErr);
				return "kept";
			}

			const note = `Original saved to ${savedTo}. ${reason}`;

			return (await flagNeedsAttention(journal, fileId, note)) ? "needsAttention" : "kept";
		}

		if (restored === "gone")
		{
			await discard("was deleted before its original could be restored");
			return "cleared";
		}

		await discard(`failed the read-back (${verifyErr.message}); original restored`);
		return "restored";
	}

	await discard("passed the read-back");
	return "cleared";
}

// Classifies one journal row by a HEAD of its object (the table in 9.3) and
// settles it. Resolves to "cleared", "restored", "needsAttention" or "kept".
async function recoverJournalRow({ sql, s3, entry, timeoutMs })
{
	const { fileId } = entry;
	const discard = async (what) =>
	{
		await withTimeout(deletePendingVerify(sql, fileId), "Clearing the crash journal", timeoutMs);
		await removeJournalOriginal(entry.originalPath, fileId);
		log.info(`Recovery: file ${fileId} ${what}; journal row cleared`);
	};
	let head;

	try
	{
		head = await headOrderFile(s3, fileId);
	}
	catch (err)
	{
		if (!isNotFound(err))
		{
			throw err;
		}

		// The order (and with it the object) was deleted.
		await discard("was deleted");
		return "cleared";
	}

	const marker = head.Metadata?.[ARCHIVE_META.method];

	if (!marker || head.ETag === entry.preUploadEtag)
	{
		const aborted = await abortMultipartUploads(s3, fileId);

		await discard(`was never replaced (${aborted} multipart upload(s) aborted)`);
		return "cleared";
	}

	if (
		marker === entry.method &&
		head.Metadata?.[ARCHIVE_META.sha256] === entry.originalSha256 &&
		head.ContentLength === entry.storedSize
	)
	{
		return recoverStoredArchive({ sql, s3, entry, head, timeoutMs, discard });
	}

	await discard("was replaced by a newer write");
	return "cleared";
}

/**
 * Crash recovery for the journal (phases-bugfix/phase4.md 9.3). Settles every
 * 'uploading' / 'uploaded' row by a HEAD of its object: deleted, never
 * replaced (any multipart upload left for the key is aborted), our archive
 * (read back; restored from the re-hashed kept original if that fails), or
 * replaced by someone else. 'needs_attention' rows are never touched. A row
 * that cannot be settled now (an S3 or database error) is kept for the next
 * run; the others are still handled. Call it under the archive lock, before
 * the candidate loop.
 *
 * @param {Function} sql postgres.js pool (not the lock client).
 * @param {object} s3 S3 client.
 * @param {object} [options]
 * @param {number} [options.timeoutMs] Bound for each journal statement.
 * @param {() => boolean} [options.shouldStop] Checked before every row.
 * @returns {Promise<{ checked: number, cleared: number, restored: number, needsAttention: number, kept: number }>}
 */
export async function recoverPendingVerifications(sql, s3, { timeoutMs = DB_TIMEOUT_MS, shouldStop = () => false } = {})
{
	if (typeof sql !== "function")
	{
		throw new TypeError("sql must be a postgres.js client");
	}

	if (typeof s3?.send !== "function")
	{
		throw new TypeError("s3 must be an S3 client");
	}

	assertTimeout(timeoutMs);

	if (typeof shouldStop !== "function")
	{
		throw new TypeError("shouldStop must be a function");
	}

	const rows = await withTimeout(listPendingVerifications(sql), "Reading the crash journal", timeoutMs);
	const summary = { checked: 0, cleared: 0, restored: 0, needsAttention: 0, kept: 0 };

	for (const row of rows)
	{
		if (shouldStop())
		{
			break;
		}

		summary.checked++;

		const entry = parseJournalRow(row);
		let outcome;

		if (!entry)
		{
			// Not written by archiveOrderFile: never acted on, and the id is not echoed.
			try
			{
				await withTimeout(
					markPendingNeedsAttention(sql, String(row?.file_id ?? ""), "Malformed crash journal row; left untouched"),
					"Flagging the crash journal row",
					timeoutMs,
				);
				summary.needsAttention++;
				log.error("A malformed crash journal row was flagged for attention");
			}
			catch (err)
			{
				summary.kept++;
				log.warn(`Could not flag a malformed crash journal row for attention: ${err.message}`);
			}

			continue;
		}

		try
		{
			outcome = await recoverJournalRow({ sql, s3, entry, timeoutMs });
		}
		catch (err)
		{
			outcome = "kept";
			log.warn(`Recovery of file ${entry.fileId} failed; journal row kept for the next run: ${err.message}`);
		}

		summary[outcome]++;
	}

	if (summary.checked > 0)
	{
		log.info(
			`Crash recovery: ${summary.checked} journal row(s) checked; ${summary.cleared} cleared, ` +
			`${summary.restored} restored, ${summary.needsAttention} need attention, ${summary.kept} kept`,
		);
	}

	return summary;
}

/**
 * Temp sweep (phases-bugfix/phase4.md 9.4): deletes every compressed
 * candidate (projecto-archive-*.zst / *.br) and every downloaded original
 * (projecto-archive-*) that no journal row references. Only regular files
 * directly in `dir` are touched, and only once their mtime is at least
 * `minAgeMs` old: a recently written file may belong to an archive still in
 * flight and is left for a later sweep (review 2026-11-20, item 5). The worker
 * runs it at startup after recovery, at each job start after recovery and
 * every IDLE_SWEEP_MS while idle, so a file kept as recent is removed by a
 * later sweep. Logs counts only. Call it under the archive lock, while no job
 * runs.
 *
 * @param {object} options
 * @param {Function} options.sql postgres.js pool.
 * @param {number} [options.timeoutMs] Bound for the journal query.
 * @param {string} [options.dir] The archiver's temp directory (os.tmpdir()).
 * @param {number} [options.minAgeMs] Files modified less than this long ago are kept.
 * @param {() => Date} [options.now]
 * @returns {Promise<{ candidatesRemoved: number, originalsRemoved: number, originalsKept: number, recentKept: number, failed: number }>}
 */
export async function sweepTempDir({
	sql,
	timeoutMs = DB_TIMEOUT_MS,
	dir = os.tmpdir(),
	minAgeMs = TEMP_SWEEP_MIN_AGE_MS,
	now = () => new Date(),
} = {})
{
	if (typeof sql !== "function")
	{
		throw new TypeError("sql must be a postgres.js client");
	}

	assertTimeout(timeoutMs);

	if (typeof dir !== "string" || dir === "")
	{
		throw new TypeError("dir must be a non-empty string");
	}

	if (!Number.isSafeInteger(minAgeMs) || minAgeMs < 0)
	{
		throw new RangeError("minAgeMs must be a non-negative integer");
	}

	if (typeof now !== "function")
	{
		throw new TypeError("now must be a function returning a Date");
	}

	// Taken before anything is read, so a file written while the sweep runs
	// is always newer than the cutoff.
	const current = now();

	if (!(current instanceof Date) || !Number.isFinite(current.getTime()))
	{
		throw new TypeError("now must return a valid Date");
	}

	const cutoffMs = current.getTime() - minAgeMs;

	// Read first: without the journal no original may be removed.
	const rows = await withTimeout(listJournalOriginalPaths(sql), "Reading the crash journal", timeoutMs);
	const referenced = new Set(
		rows
			.map((row) => row.original_path)
			.filter((value) => typeof value === "string" && value !== "")
			.map((value) => path.resolve(value)),
	);
	const counts = { candidatesRemoved: 0, originalsRemoved: 0, originalsKept: 0, recentKept: 0, failed: 0 };
	const entries = await readdir(dir, { withFileTypes: true });

	for (const entry of entries)
	{
		if (!entry.isFile() || !entry.name.startsWith(TEMP_FILE_PREFIX))
		{
			continue;
		}

		const filePath = path.join(dir, entry.name);
		const isCandidate = TEMP_CANDIDATE_PATTERN.test(entry.name);

		if (!isCandidate && referenced.has(path.resolve(filePath)))
		{
			counts.originalsKept++;
			continue;
		}

		try
		{
			// lstat, not stat: a symlink swapped in since readdir is never followed.
			const stats = await lstat(filePath);

			// A file whose mtime is in the future (clock skew) counts as recent.
			if (!stats.isFile() || stats.mtimeMs > cutoffMs)
			{
				counts.recentKept++;
				continue;
			}

			await removeTempFile(filePath);
			counts[isCandidate ? "candidatesRemoved" : "originalsRemoved"]++;
		}
		catch (err)
		{
			// Gone since readdir: nothing left to sweep.
			if (err?.code !== "ENOENT")
			{
				counts.failed++;
			}
		}
	}

	log.info(
		`Temp sweep: removed ${counts.candidatesRemoved} compressed candidate(s) and ${counts.originalsRemoved} ` +
		`unreferenced original(s); kept ${counts.originalsKept} original(s) the crash journal references` +
		` and ${counts.recentKept} file(s) modified in the last ${Math.round(minAgeMs / 60_000)} minute(s)` +
		(counts.failed > 0 ? `; ${counts.failed} could not be removed` : ""),
	);

	return counts;
}
