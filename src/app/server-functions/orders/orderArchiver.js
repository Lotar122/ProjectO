import "server-only";

import {
	AbortMultipartUploadCommand,
	DeleteObjectCommand,
	HeadObjectCommand,
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { Transform, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";

import { DB } from "@/app/lib/db";
import { createLogger } from "@/app/lib/logger";
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
	compressBest,
	createDecompressStream,
	createTempFilePath,
	removeTempFile,
} from "@/app/server-functions/orders/fileCompression";
import {
	ORDER_FILES_BUCKET,
	isPreconditionFailed,
	updateOrderFileMetadata,
} from "@/app/server-functions/orders/orderFiles";

const log = createLogger("archiver");

// Orders whose issue date is further back than this are archived.
export const ARCHIVE_AFTER_DAYS = 30;
export const MIN_SAVINGS_RATIO = 0.02;

// Session-level advisory lock that keeps two server instances from archiving
// at the same time. Any constant works as long as nothing else uses it.
const ARCHIVE_LOCK_KEY = "5067091845220771";
const PART_SIZE_BYTES = 8 * 1024 * 1024;
const SIZE_PATTERN = /^\d+$/;

// Upper bound for the lock queries on the reserved connection (and the job's
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

// Rejects with DbTimeoutError when promise has not settled within ms. A query
// cannot be cancelled from here, so onLate (if given) is called with
// (err, value) when it settles after the timeout, to clean up after it.
function withTimeout(promise, label, ms, onLate)
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

// Writes source to filePath, hashing the bytes on the way.
async function saveToFile(source, filePath)
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
				callback(null, chunk);
			},
		}),
		createWriteStream(filePath),
	);

	return { sha256: hash.digest("hex"), size };
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
// a rename that lands between the last HEAD and this write is still lost;
// renames that come after it re-read the metadata (updateOrderFileMetadata).
//
// Resolves to the ETag of the written object.
async function uploadOrderFile(s3, fileId, filePath, { contentType, metadata, ifMatch })
{
	const upload = new Upload({
		client: s3,
		params: {
			Bucket: ORDER_FILES_BUCKET,
			Key: fileId,
			Body: createReadStream(filePath),
			...(contentType ? { ContentType: contentType } : {}),
			...(ifMatch ? { IfMatch: ifMatch } : {}),
			Metadata: metadata,
		},
		queueSize: 1,
		partSize: PART_SIZE_BYTES,
		leavePartsOnError: false,
	});

	try
	{
		const result = await upload.done();

		return result?.ETag ?? null;
	}
	catch (err)
	{
		// lib-storage does not abort the multipart upload when its completion
		// is refused, which would leave the parts behind.
		if (upload.uploadId)
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
}

function recoveryDir()
{
	return process.env.ARCHIVER_RECOVERY_DIR || path.join(process.cwd(), "archiver-recovery");
}

// Copies the verified original out of the temp directory (which is often
// ephemeral in containers) when it is the only good copy left, next to a JSON
// file with what is needed to put it back. Resolves to the copy's path.
async function saveForRecovery({ fileId, originalPath, contentType, metadata, original, reason })
{
	const dir = recoveryDir();
	const baseName = encodeURIComponent(fileId);
	const filePath = path.join(dir, `${baseName}.orig`);

	await mkdir(dir, { recursive: true });
	await copyFile(originalPath, filePath);
	await writeFile(
		path.join(dir, `${baseName}.json`),
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
	);

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

	const roundTrip = await hashStream(stored.body, createDecompressStream(candidate.method));

	assertChecksum(fileId, original, roundTrip, `stored ${candidate.method} archive read back`);
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
// failed. compress is for tests.
export async function archiveOrderFile({
	s3,
	fileId,
	isStillAttached = async () => true,
	minSavingsRatio = MIN_SAVINGS_RATIO,
	now = () => new Date(),
	compress = compressBest,
})
{
	const head = await headOrderFile(s3, fileId);

	if (head.Metadata?.[ARCHIVE_META.method])
	{
		return alreadyArchivedResult(head.Metadata, head.ContentLength);
	}

	const originalPath = createTempFilePath();
	let candidate = null;
	let keepOriginal = false;

	try
	{
		const file = await getFile(s3, ORDER_FILES_BUCKET, fileId);

		if (file.metadata?.[ARCHIVE_META.method])
		{
			file.body?.destroy?.();
			return alreadyArchivedResult(file.metadata, file.contentLength);
		}

		const original = await saveToFile(file.body, originalPath);

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

		candidate = await compress(originalPath, { minSavingsRatio });

		if (!candidate)
		{
			let updated;

			try
			{
				updated = await updateOrderFileMetadata(s3, fileId, (current) =>
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
		const verified = await hashStream(
			createReadStream(candidate.path),
			createDecompressStream(candidate.method),
		);

		assertChecksum(fileId, original, verified, `${candidate.method} round trip; original left untouched`);

		// Fresh metadata, so a rename that happened during compression is kept.
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

		const contentType = latest.ContentType ?? file.contentType;
		const originalMetadata = { ...latest.Metadata, [ARCHIVE_META.sha256]: original.sha256 };
		const orphanedResult = {
			outcome: FILE_OUTCOMES.orphaned,
			method: candidate.method,
			originalSize: original.size,
			storedSize: candidate.size,
		};
		let storedEtag;

		try
		{
			// Bound to the version checked above: a replace or delete since then
			// (e.g. the order being deleted) refuses the write and leaves the
			// object as the other writer left it.
			storedEtag = await uploadOrderFile(s3, fileId, candidate.path, {
				contentType,
				metadata: {
					...latest.Metadata,
					...archiveMetadata(candidate.method),
				},
				ifMatch: latest.ETag,
			});
		}
		catch (err)
		{
			if (isConcurrentChange(err))
			{
				log.info(`File ${fileId} changed or was deleted before its archive was written; left for the next run`);
				return changedResult(original.size);
			}

			throw err;
		}

		try
		{
			await verifyStoredObject(s3, fileId, candidate, original);
		}
		catch (verifyErr)
		{
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

				return orphanedResult;
			}

			log.error(`Archived file ${fileId} failed read-back verification, restoring the original`, verifyErr);

			try
			{
				// Only over our own archive, never over a newer write.
				await uploadOrderFile(s3, fileId, originalPath, {
					contentType,
					metadata: originalMetadata,
					ifMatch: storedEtag,
				});
			}
			catch (restoreErr)
			{
				if (isNotFound(restoreErr))
				{
					// Deleted meanwhile (an order deletion removes its objects
					// before the row), so there is nothing to restore.
					log.info(`File ${fileId} was deleted during archiving; nothing to restore`);
					return changedResult(original.size);
				}

				// The verified original on disk may now be the only good copy.
				let savedTo = null;

				try
				{
					savedTo = await saveForRecovery({
						fileId,
						originalPath,
						contentType,
						metadata: originalMetadata,
						original,
						reason: `Read-back: ${verifyErr.message}; restore: ${restoreErr.message}`,
					});
				}
				catch (saveErr)
				{
					keepOriginal = true;
					log.error(`Could not save file ${fileId} to ${recoveryDir()}`, saveErr);
				}

				const location = savedTo ?? originalPath;

				log.error(`Could not restore file ${fileId}; original kept at ${location}`, restoreErr);

				throw new ArchiveFileError(
					`Read-back verification and restore failed; original kept at ${location}`,
					{ cause: verifyErr },
				);
			}

			throw new ArchiveFileError(
				`Read-back verification failed, original restored: ${verifyErr.message}`,
				{ cause: verifyErr },
			);
		}

		if (!(await isStillAttached()))
		{
			await deleteOrderFileObject(s3, fileId);
			log.info(`File ${fileId} was removed from its order during archiving; deleted the object`);

			return orphanedResult;
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

		if (!keepOriginal)
		{
			await removeTempFile(originalPath).catch((err) =>
				log.warn(`Could not remove temp file ${originalPath}: ${err.message}`));
		}
	}
}

// ---- Database access (all short statements; statement_timeout is 15 s) ----

export async function selectArchiveCandidates(sql = DB)
{
	return sql`
		SELECT order_id, files
		FROM orders
		WHERE issue_date < CURRENT_DATE - ${ARCHIVE_AFTER_DAYS}::int
			AND archived_at IS NULL
		ORDER BY issue_date, order_id
	`;
}

export async function countArchiveCandidates(sql = DB)
{
	const [row] = await sql`
		SELECT count(*)::int AS count
		FROM orders
		WHERE issue_date < CURRENT_DATE - ${ARCHIVE_AFTER_DAYS}::int
			AND archived_at IS NULL
	`;

	return row?.count ?? 0;
}

export async function isFileOnOrder(sql, orderId, fileId)
{
	const rows = await sql`
		SELECT 1
		FROM orders
		WHERE order_id = ${orderId}
			AND ${fileId} = ANY(files)
	`;

	return rows.length > 0;
}

// Only marks the order when its files are still the ones that were archived;
// an order edited meanwhile is left for the next run.
export async function markOrderArchived(sql, orderId, files)
{
	const rows = await sql`
		UPDATE orders
		SET archived_at = now()
		WHERE order_id = ${orderId}
			AND files IS NOT DISTINCT FROM ${files}
			AND archived_at IS NULL
		RETURNING order_id
	`;

	return rows.length > 0;
}

// Resolves to the lock { reserved, pid } (a reserved connection holding the
// lock and its backend pid), or null if another session holds it.
async function acquireArchiveLock(sql, timeoutMs)
{
	// A connection that arrives after we gave up goes straight back.
	const reserved = await withTimeout(
		sql.reserve(),
		"Reserving a database connection",
		timeoutMs,
		(err, late) => late?.release(),
	);
	let row;

	try
	{
		[row] = await withTimeout(
			reserved`SELECT pg_backend_pid() AS pid, pg_try_advisory_lock(${ARCHIVE_LOCK_KEY}::bigint) AS locked`,
			"Taking the archive lock",
			timeoutMs,
			// Settled after we gave up: drop whatever it took, then the connection.
			() => releaseArchiveLock({ reserved }, timeoutMs),
		);
	}
	catch (err)
	{
		// After a timeout the late handler above releases the connection.
		if (!(err instanceof DbTimeoutError))
		{
			reserved.release();
		}

		throw err;
	}

	if (row?.locked)
	{
		return { reserved, pid: row.pid };
	}

	reserved.release();

	return null;
}

// A session lock lives as long as its connection. postgres.js does not keep a
// dropped reserved connection reserved: the next query on it reconnects as a
// new session (which no longer holds the lock, and which the pool may share),
// or does not settle at all. So the backend pid must still be the one that
// took the lock, and the query is bounded by timeoutMs. Session locks are
// re-entrant, so pg_try_advisory_lock succeeds while we hold the lock; it
// also catches a recycled pid in a session that does not hold it.
async function confirmArchiveLock(lock, timeoutMs)
{
	const [row] = await withTimeout(
		lock.reserved`SELECT pg_backend_pid() AS pid, pg_try_advisory_lock(${ARCHIVE_LOCK_KEY}::bigint) AS locked`,
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

// Never throws. pg_advisory_unlock_all also drops the re-entrant holds taken
// by confirmArchiveLock.
async function releaseArchiveLock(lock, timeoutMs)
{
	try
	{
		await withTimeout(
			lock.reserved`SELECT pg_advisory_unlock_all()`,
			"Releasing the archive lock",
			timeoutMs,
		);
	}
	catch (err)
	{
		// The lock goes with the session when postgres.js closes the connection.
		log.warn(`Could not release the archive lock: ${err.message}`);
	}

	try
	{
		lock.reserved.release();
	}
	catch (err)
	{
		log.warn(`Could not return the archive lock connection: ${err.message}`);
	}
}

// ---- Job state ----

function createStatus(overrides = {})
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

const globalForArchiver = globalThis;

function getArchiver()
{
	globalForArchiver.__projectoArchiver ??= {
		starting: false,
		status: createStatus(),
	};

	return globalForArchiver.__projectoArchiver;
}

export function getArchiveJobStatus()
{
	return { ...getArchiver().status };
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

async function archiveOrder({ sql, s3, order, status, timeoutMs })
{
	const orderId = order.order_id;
	const files = Array.isArray(order.files) ? order.files : [];
	let failedFiles = 0;
	let changedFiles = 0;

	for (const fileId of files)
	{
		try
		{
			const result = await archiveOrderFile({
				s3,
				fileId,
				isStillAttached: () => withTimeout(
					isFileOnOrder(sql, orderId, fileId),
					"Checking the order's files",
					timeoutMs,
				),
			});

			recordFileResult(status, result);

			if (result.outcome === FILE_OUTCOMES.changed)
			{
				changedFiles++;
			}
		}
		catch (err)
		{
			failedFiles++;
			recordFileResult(status, failedResult(err), fileId);

			if (err instanceof ChecksumMismatchError)
			{
				log.error(`Checksum verification failed for file ${fileId} of order ${orderId}; source left untouched`, err);
			}
			else
			{
				log.warn(`Could not archive file ${fileId} of order ${orderId}: ${err.message}`);
			}
		}
	}

	if (failedFiles > 0)
	{
		status.ordersFailed++;
		return;
	}

	if (changedFiles > 0)
	{
		status.ordersDone++;
		status.ordersChanged++;
		log.info(`Order ${orderId} had ${changedFiles} file(s) changed during archiving; left for the next run`);
		return;
	}

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
			log.info(`Order ${orderId} changed during archiving; left for the next run`);
		}
	}
	catch (err)
	{
		status.ordersFailed++;
		status.lastError = `Order ${orderId}: ${err.message}`;
		log.warn(`Could not mark order ${orderId} as archived: ${err.message}`);
	}
}

async function runArchiveJob({ sql, s3: injectedS3, lock, status, timeoutMs })
{
	let finalState = "done";

	try
	{
		const s3 = injectedS3 ?? await createS3Client();
		const orders = await withTimeout(
			selectArchiveCandidates(sql),
			"Selecting archive candidates",
			timeoutMs,
		);

		status.ordersTotal = orders.length;
		log.info(`Archive job started by ${status.triggeredBy ?? "unknown"}: ${orders.length} order(s)`);

		for (const order of orders)
		{
			await confirmArchiveLock(lock, timeoutMs);
			await archiveOrder({ sql, s3, order, status, timeoutMs });
		}
	}
	catch (err)
	{
		finalState = "failed";
		status.lastError = err.message;
		log.error("Archive job failed", err);
	}
	finally
	{
		// Released before the state flips, so a new start right after "done"
		// is not refused by our own lock. Bounded by timeoutMs and never
		// throws, but the state is set even if it did.
		try
		{
			await releaseArchiveLock(lock, timeoutMs);
		}
		finally
		{
			status.finishedAt = new Date().toISOString();
			status.state = finalState;
		}
	}

	log.info(
		`Archive job ${finalState}: orders ${status.ordersDone}/${status.ordersTotal} done, ` +
		`${status.ordersFailed} failed; files ${status.filesCompressed} compressed, ` +
		`${status.filesSkipped} skipped, ${status.filesChanged} changed, ${status.filesFailed} failed; ` +
		`${status.bytesBefore} -> ${status.bytesAfter} bytes`,
	);
}

// Starts the job in the background and returns at once. Refused with
// reason "already-running" when a job runs in this process or another
// instance holds the lock. sql, s3 and dbTimeoutMs are for tests.
export async function startArchiveJob({
	triggeredBy,
	sql = DB,
	s3 = null,
	dbTimeoutMs = DB_TIMEOUT_MS,
} = {})
{
	const archiver = getArchiver();

	if (archiver.starting || archiver.status.state === "running")
	{
		return { started: false, status: getArchiveJobStatus(), reason: "already-running" };
	}

	archiver.starting = true;

	let lock;

	try
	{
		lock = await acquireArchiveLock(sql, dbTimeoutMs);
	}
	finally
	{
		archiver.starting = false;
	}

	if (!lock)
	{
		return { started: false, status: getArchiveJobStatus(), reason: "already-running" };
	}

	const status = createStatus({
		state: "running",
		startedAt: new Date().toISOString(),
		triggeredBy: triggeredBy ?? null,
	});

	archiver.status = status;

	runArchiveJob({ sql, s3, lock, status, timeoutMs: dbTimeoutMs }).catch((err) =>
	{
		status.finishedAt ??= new Date().toISOString();
		status.state = "failed";
		status.lastError = err.message;
		log.error("Archive job crashed", err);
	});

	return { started: true, status: getArchiveJobStatus() };
}
