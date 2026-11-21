import "server-only";

import { mapWithConcurrency } from "@/app/lib/concurrency";
import { createBucket } from "@/app/server-functions/MinIO/createBucket";
import { encodeMetadataValue } from "@/app/server-functions/MinIO/metadataEncoding";
import { listJournaledFileIds } from "@/app/server-functions/orders/archiveJournal";
import {
	CopyObjectCommand,
	DeleteObjectsCommand,
	HeadObjectCommand,
} from "@aws-sdk/client-s3";

export const ORDER_FILES_BUCKET = "projecto";

function escapeRegExp(value)
{
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function sanitizeOrderFileName(patient, originalFileName)
{
	const extensionIndex = originalFileName.lastIndexOf(".");
	const hasExtension = extensionIndex !== -1;
	const extension = hasExtension ? originalFileName.slice(extensionIndex) : "";
	let baseName = hasExtension ?
		originalFileName.slice(0, extensionIndex) :
		originalFileName;

	const patientParts = String(patient || "")
		.split(/\s+/)
		.map((part) => part.trim())
		.filter(Boolean)
		.sort((a, b) => b.length - a.length);

	for (const part of patientParts)
	{
		const escapedPart = escapeRegExp(part);
		baseName = baseName.replace(
			new RegExp(`(^|[\\s_-])${escapedPart}(?=$|[\\s_-])`, "gi"),
			"$1",
		);
	}

	baseName = baseName
		.replace(/[\s_-]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();

	const normalizedBaseName = baseName.toLowerCase();
	const normalizedExtension = extension.toLowerCase();

	if (normalizedExtension === ".stl")
	{
		if (/upper/.test(normalizedBaseName))
		{
			return "UpperJawScan.stl";
		}

		if (/lower/.test(normalizedBaseName))
		{
			return "LowerJawScan.stl";
		}
	}

	return baseName ? `${baseName}${extension}` : `file${extension}`;
}

// Checked once per process instead of a HeadBucket on every upload.
// Reset on failure so the next request retries.
let orderFilesBucketReady = null;

export async function ensureOrderFilesBucket(s3)
{
	orderFilesBucketReady ??= createBucket(s3, ORDER_FILES_BUCKET).catch((err) =>
	{
		orderFilesBucketReady = null;
		throw err;
	});

	await orderFilesBucketReady;
}

// S3 DeleteObjects takes at most 1000 keys per call.
const DELETE_BATCH_SIZE = 1000;

// Resolves to the ids that could not be deleted (empty when everything went through).
export async function deleteOrderFiles(s3, fileIds)
{
	const failedIds = [];

	for (let offset = 0; offset < fileIds.length; offset += DELETE_BATCH_SIZE)
	{
		const batch = fileIds.slice(offset, offset + DELETE_BATCH_SIZE);
		const result = await s3.send(
			new DeleteObjectsCommand({
				Bucket: ORDER_FILES_BUCKET,
				Delete: {
					Objects: batch.map((fileId) => ({ Key: fileId })),
					Quiet: true,
				},
			}),
		);

		failedIds.push(...(result.Errors ?? []).map((error) => error.Key));
	}

	return failedIds;
}

async function tryDeleteOrderFiles(s3, fileIds, log, context)
{
	try
	{
		return await deleteOrderFiles(s3, fileIds);
	}
	catch (err)
	{
		log.error(`Deleting ${fileIds.length} file(s) of ${context} failed`, err);

		return [...fileIds];
	}
}

/**
 * Deletes files that no order points at (cleanup after a failed request).
 * Never throws: ids that are still in storage after one retry are logged as
 * an error and returned, so the caller can keep its original response.
 *
 * @param {object} s3 S3 client.
 * @param {readonly string[]} fileIds Keys to delete.
 * @param {object} options
 * @param {{ error: (message: string, details?: unknown) => void }} options.log Logger of the caller.
 * @param {string} options.context What the files belonged to, for the log line (e.g. "a failed order").
 * @returns {Promise<string[]>} Ids that could not be deleted.
 */
export async function cleanUpOrderFiles(s3, fileIds, { log, context })
{
	if (!Array.isArray(fileIds))
	{
		throw new TypeError("cleanUpOrderFiles expects an array of file ids");
	}

	if (fileIds.length === 0)
	{
		return [];
	}

	let failedIds = await tryDeleteOrderFiles(s3, fileIds, log, context);

	if (failedIds.length > 0)
	{
		failedIds = await tryDeleteOrderFiles(s3, failedIds, log, context);
	}

	if (failedIds.length > 0)
	{
		log.error(`${failedIds.length} file(s) of ${context} left in storage: ${failedIds.join(", ")}`);
	}

	return failedIds;
}

const METADATA_UPDATE_ATTEMPTS = 3;

// True for a failed S3 precondition (If-Match / x-amz-copy-source-if-match).
export function isPreconditionFailed(err)
{
	return err?.name === "PreconditionFailed" || err?.$metadata?.httpStatusCode === 412;
}

// buildUpdate receives the current metadata and returns the keys to change,
// or null to leave the object untouched (no copy needed).
//
// The copy only goes through while the object still has the ETag that was read
// (CopySourceIfMatch). Otherwise the archiver could replace the bytes between
// the HEAD and the copy, and the copy would put the stale metadata (without
// `compression`) on compressed bytes. On a precondition failure the metadata
// is read again and buildUpdate re-run on it. A metadata-only copy keeps the
// content ETag, so this guards against content replacements, not against two
// concurrent metadata updates.
//
// beforeCopy, when given, runs right before each copy (after buildUpdate asked
// for one) and may throw to refuse it.
export async function updateOrderFileMetadata(s3, fileId, buildUpdate, { beforeCopy } = {})
{
	for (let attempt = 1; ; attempt++)
	{
		const head = await s3.send(
			new HeadObjectCommand({
				Bucket: ORDER_FILES_BUCKET,
				Key: fileId,
			}),
		);
		const metadataUpdate = buildUpdate(head.Metadata ?? {});

		if (!metadataUpdate)
		{
			return false;
		}

		await beforeCopy?.();

		try
		{
			await s3.send(
				new CopyObjectCommand({
					Bucket: ORDER_FILES_BUCKET,
					Key: fileId,
					CopySource: `${ORDER_FILES_BUCKET}/${encodeURIComponent(fileId)}`,
					...(head.ETag ? { CopySourceIfMatch: head.ETag } : {}),
					ContentType: head.ContentType,
					ChecksumAlgorithm: "SHA256",
					Metadata: {
						...head.Metadata,
						...metadataUpdate,
					},
					MetadataDirective: "REPLACE",
				}),
			);

			return true;
		}
		catch (err)
		{
			if (!isPreconditionFailed(err) || attempt >= METADATA_UPDATE_ATTEMPTS)
			{
				throw err;
			}
		}
	}
}

/**
 * A rename refused because the archiver is replacing the file right now (it
 * has a crash journal row). Nothing was written; the rename can be sent again
 * once the archiver is done with the file, usually within minutes.
 */
export class FileBeingArchivedError extends Error
{
	/**
	 * @param {readonly string[]} fileIds The files being archived.
	 */
	constructor(fileIds)
	{
		super(`File(s) being archived, rename refused: ${fileIds.join(", ")}`);
		this.name = "FileBeingArchivedError";
		this.fileIds = [...fileIds];
	}
}

// Throws FileBeingArchivedError when any of fileIds has a journal row.
async function assertNotBeingArchived(sql, fileIds)
{
	const rows = await listJournaledFileIds(sql, fileIds);

	if (rows.length > 0)
	{
		throw new FileBeingArchivedError(rows.map((row) => row.file_id));
	}
}

function assertSqlClient(sql, name)
{
	if (typeof sql !== "function")
	{
		throw new TypeError(`${name}: options.sql must be a postgres.js client`);
	}
}

/**
 * Sets the file's display name (metadata `original_name`). Resolves to false
 * when the file already has that name, so unchanged attachments are not
 * rewritten in S3 on every save.
 *
 * Refused with FileBeingArchivedError while the file has an archive journal
 * row (archiveJournal.js): the archiver replaces the object with metadata it
 * read once the row was in place, so a rename copied during the upload would
 * be overwritten (review 2026-11-20, item 3). The check runs right before the
 * copy, after the HEAD, to keep the remaining window small: a rename whose
 * check passes just before the archiver inserts its row, and whose copy lands
 * after the archiver's last HEAD (taken right after that insert, see
 * archiveOrderFile), is still lost. That window is one journal query plus one
 * S3 round trip wide; closing it would need a lock shared by the web and the
 * archiver around the HEAD and the copy.
 *
 * @param {object} s3 S3 client.
 * @param {string} fileId
 * @param {string} fileName New display name (already sanitized).
 * @param {object} options
 * @param {Function} options.sql postgres.js client for the journal check.
 * @returns {Promise<boolean>}
 */
export async function renameOrderFile(s3, fileId, fileName, { sql } = {})
{
	assertSqlClient(sql, "renameOrderFile");

	const encodedName = encodeMetadataValue(fileName);

	return updateOrderFileMetadata(
		s3,
		fileId,
		(metadata) => metadata.original_name === encodedName ? null : { original_name: encodedName },
		{ beforeCopy: () => assertNotBeingArchived(sql, [fileId]) },
	);
}

export async function setOrderFileChecksum(s3, fileId, sha256)
{
	return updateOrderFileMetadata(s3, fileId, (metadata) =>
		metadata.sha256 === sha256 ? null : { sha256 });
}

const RENAME_CONCURRENCY = 4;

/**
 * Reads the rename requests of an edit form: requestedFileNames are its
 * JSON-encoded { fileId, fileName } entries. Malformed entries, empty names
 * and files not in fileIds are dropped; names are sanitized for the patient.
 *
 * @param {string} patient
 * @param {readonly string[]} fileIds Files that may be renamed.
 * @param {readonly string[]} requestedFileNames
 * @returns {{ fileId: string, fileName: string }[]}
 */
export function parseFileRenames(patient, fileIds, requestedFileNames)
{
	const updates = [];

	for (const value of requestedFileNames)
	{
		let fileNameUpdate;

		try
		{
			fileNameUpdate = JSON.parse(String(value));
		}
		catch
		{
			continue;
		}

		const fileId = String(fileNameUpdate?.fileId);
		const fileName = String(fileNameUpdate?.fileName || "").trim();

		if (fileIds.includes(fileId) && fileName)
		{
			updates.push({ fileId, fileName: sanitizeOrderFileName(patient, fileName) });
		}
	}

	return updates;
}

function isNotFound(err)
{
	return err?.name === "NotFound" || err?.name === "NoSuchKey" || err?.$metadata?.httpStatusCode === 404;
}

/**
 * The files among `renames` that the archiver is replacing right now and whose
 * name the rename would actually change, so an edit can be refused (409)
 * before anything is saved. A rename to the current name changes nothing and
 * is not refused. Runs no query and no request when `renames` is empty, and
 * HEADs only the files that have a journal row.
 *
 * @param {object} s3 S3 client.
 * @param {Function} sql postgres.js client.
 * @param {readonly { fileId: string, fileName: string }[]} renames From parseFileRenames.
 * @returns {Promise<string[]>}
 */
export async function findRenamesBlockedByArchiving(s3, sql, renames)
{
	assertSqlClient(sql, "findRenamesBlockedByArchiving");

	if (renames.length === 0)
	{
		return [];
	}

	const rows = await listJournaledFileIds(sql, renames.map(({ fileId }) => fileId));
	const journaled = new Set(rows.map((row) => row.file_id));
	const candidates = renames.filter(({ fileId }) => journaled.has(fileId));
	const changes = await Promise.all(candidates.map(async ({ fileId, fileName }) =>
	{
		try
		{
			const head = await s3.send(new HeadObjectCommand({ Bucket: ORDER_FILES_BUCKET, Key: fileId }));

			return head.Metadata?.original_name !== encodeMetadataValue(fileName);
		}
		catch (err)
		{
			// A file that is gone cannot be renamed; the rename itself reports it.
			if (isNotFound(err))
			{
				return false;
			}

			throw err;
		}
	}));

	return candidates.filter((_, index) => changes[index]).map(({ fileId }) => fileId);
}

/**
 * Renames the files that stay on the order. A file the archiver started on
 * since the edit was checked (see renameOrderFile) is skipped without stopping
 * the others; the call then rejects with one FileBeingArchivedError naming
 * every skipped file. Any other failure rejects as before.
 *
 * @param {object} s3 S3 client.
 * @param {string} patient
 * @param {readonly string[]} retainedFileIds
 * @param {readonly string[]} requestedFileNames JSON-encoded { fileId, fileName } entries.
 * @param {object} options
 * @param {Function} options.sql postgres.js client for the journal check.
 * @returns {Promise<void>}
 */
export async function renameRetainedFiles(s3, patient, retainedFileIds, requestedFileNames, { sql } = {})
{
	assertSqlClient(sql, "renameRetainedFiles");

	const updates = parseFileRenames(patient, retainedFileIds, requestedFileNames);
	const blocked = [];

	await mapWithConcurrency(updates, RENAME_CONCURRENCY, async ({ fileId, fileName }) =>
	{
		try
		{
			await renameOrderFile(s3, fileId, fileName, { sql });
		}
		catch (err)
		{
			if (!(err instanceof FileBeingArchivedError))
			{
				throw err;
			}

			blocked.push(...err.fileIds);
		}
	});

	if (blocked.length > 0)
	{
		throw new FileBeingArchivedError(blocked);
	}
}
