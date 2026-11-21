import "server-only";

import { HeadObjectCommand } from "@aws-sdk/client-s3";

import { DB } from "@/app/lib/db";
import { ARCHIVE_META } from "@/app/server-functions/orders/fileCompression";
import { ORDER_LIMITS } from "@/app/server-functions/orders/multipartUpload";
import {
	ORDER_FILES_BUCKET,
	cleanUpOrderFiles,
	findRenamesBlockedByArchiving,
	parseFileRenames,
	renameRetainedFiles,
} from "@/app/server-functions/orders/orderFiles";
import { isDeletionActive, selectOrderForUpdate } from "@/app/server-functions/orders/orderRowLock";

const SIZE_PATTERN = /^\d+$/;

function isNotFound(err)
{
	return err?.name === "NotFound" || err?.name === "NoSuchKey" || err?.$metadata?.httpStatusCode === 404;
}

// Size of the file as the user uploaded it: an archived file is stored
// compressed, so its original size comes from the archive metadata.
async function readOriginalSize(s3, fileId)
{
	try
	{
		const head = await s3.send(new HeadObjectCommand({ Bucket: ORDER_FILES_BUCKET, Key: fileId }));
		const originalSize = head.Metadata?.[ARCHIVE_META.originalSize];

		return typeof originalSize === "string" && SIZE_PATTERN.test(originalSize)
			? Number(originalSize)
			: head.ContentLength ?? 0;
	}
	catch (err)
	{
		// A file that is gone takes no space.
		if (isNotFound(err))
		{
			return 0;
		}

		throw err;
	}
}

// Sizes of the files the client says it keeps, read before the row is locked
// so no S3 request runs inside the transaction. Only sizes of files that turn
// out to be on the locked order are used, so ids of other orders reveal nothing.
async function readKeptFileSizes(s3, existingFileIds)
{
	const fileIds = [...new Set(existingFileIds)];
	const sizes = await Promise.all(fileIds.map((fileId) => readOriginalSize(s3, fileId)));

	return new Map(fileIds.map((fileId, index) => [fileId, sizes[index]]));
}

// Checks the order as it will be after the edit against ORDER_LIMITS. Only
// edits that add files are checked, so an order that is already over a limit
// (saved before the limit existed) can still be edited and trimmed. A kept file
// whose size was not read (added by a concurrent edit the client never saw)
// counts as the largest allowed file, so leaving files out of the request
// cannot get around the byte limit.
function orderLimitViolation({ retainedFileIds, uploadedFileIds, uploadedBytes, keptFileSizes, limits })
{
	if (uploadedFileIds.length === 0)
	{
		return null;
	}

	if (retainedFileIds.length + uploadedFileIds.length > limits.maxFiles)
	{
		return `At most ${limits.maxFiles} files per order`;
	}

	const retainedBytes = retainedFileIds.reduce(
		(sum, fileId) => sum + (keptFileSizes.get(fileId) ?? limits.maxFileBytes),
		0,
	);

	if (retainedBytes + uploadedBytes > limits.maxTotalBytes)
	{
		return "Order files are too large in total";
	}

	return null;
}

// A file is removed when the client left it out of `existingFileIds` and knew
// about it. Without `knownFileIds` (older clients) every file left out is
// removed, as before. With it, files added by a concurrent edit the client
// never saw stay on the order instead of being deleted.
function splitFileIds(currentFileIds, existingFileIds, knownFileIds)
{
	const removedFileIds = currentFileIds.filter((fileId) =>
		!existingFileIds.includes(fileId) &&
		(knownFileIds === null || knownFileIds.includes(fileId)));
	const retainedFileIds = currentFileIds.filter((fileId) => !removedFileIds.includes(fileId));

	return { retainedFileIds, removedFileIds };
}

function parseKnownFileIds(value)
{
	try
	{
		const parsed = JSON.parse(value);

		return Array.isArray(parsed) && parsed.every((item) => typeof item === "string") ? parsed : null;
	}
	catch
	{
		return null;
	}
}

/**
 * Reads the optional `knownFileIds` form field: a JSON array with the file ids
 * the client saw on the order when the edit started.
 *
 * A field that is present but malformed is logged and read as an empty list,
 * so the edit removes no files: a broken client must not delete files by accident.
 *
 * @param {string | null} value Raw field value (null when the field is absent).
 * @param {object} options
 * @param {{ warn: (message: string) => void }} options.log Logger of the caller.
 * @param {string} options.orderID Order being edited, for the log line.
 * @returns {string[] | null} The ids, [] when malformed, or null when absent (then
 *   every file left out of `existingFileIds` counts as removed, as for older clients).
 */
export function readKnownFileIds(value, { log, orderID })
{
	if (typeof log?.warn !== "function")
	{
		throw new TypeError("readKnownFileIds: log must be a logger");
	}

	if (value === null || value === undefined)
	{
		return null;
	}

	const knownFileIds = typeof value === "string" ? parseKnownFileIds(value) : null;

	if (knownFileIds === null)
	{
		log.warn(`Order ${orderID}: malformed knownFileIds, no files are removed by this edit`);

		return [];
	}

	return knownFileIds;
}

function assertStringArray(value, name)
{
	if (!Array.isArray(value) || !value.every((item) => typeof item === "string"))
	{
		throw new TypeError(`applyOrderEdit: ${name} must be an array of strings`);
	}
}

/**
 * Applies an order edit atomically. The order row is locked (`SELECT ... FOR
 * UPDATE`) while the new file list is computed and written, so two edits of
 * the same order, or an edit racing a delete or a status change, cannot work
 * from a stale read.
 *
 * S3 work happens only after the commit: retained files are renamed (metadata
 * only) and removed files are deleted. Failures there are logged and do not
 * undo the saved edit, because the order then already points at the uploads.
 *
 * When the result is not "ok", nothing was written and the caller still owns
 * `uploadedFileIds` (it should delete them).
 *
 * An edit that adds files is refused with "limit" when the order would then
 * exceed `limits` (files per order, bytes per order). The file count is checked
 * under the row lock; the sizes of the kept files are read from S3 just before.
 *
 * An order whose deletion is running (orders.deleting_at set and younger than
 * DELETION_STALE_AFTER_MS, see deleteOrderWithFiles) is refused with
 * "deleting", so a deletion never meets files it did not see. An edit that
 * would rename a file the archiver is replacing right now is refused with
 * "archiving" (review 2026-11-20, item 3); that check runs under the row lock
 * on the files the order really keeps, so a client-supplied id of another
 * order's file is never looked up. renameOrderFile checks again right before
 * each copy, so a file the archiver starts on in between is not renamed
 * (logged, the rest of the edit stays saved).
 *
 * @param {object} options
 * @param {object} options.s3 S3 client.
 * @param {string} options.orderID Order to edit.
 * @param {string | null} options.ownerId Owner the order must belong to; null for an admin edit.
 * @param {string} options.patient New patient name.
 * @param {string} options.details New details.
 * @param {string | null} options.dueDate New due date (YYYY-MM-DD) or null.
 * @param {readonly string[]} options.existingFileIds Files the client keeps.
 * @param {readonly string[] | null} [options.knownFileIds] Files the client saw on the order when the
 *   edit started; null when the client did not send them.
 * @param {readonly string[]} options.uploadedFileIds Files uploaded with this edit, appended in order.
 * @param {number} [options.uploadedBytes] Total size of the uploaded files in bytes.
 * @param {readonly string[]} options.fileNameUpdates JSON-encoded { fileId, fileName } rename requests.
 * @param {(row: { status: string | null }) => boolean} [options.assertEditable] Returns false when the
 *   locked order may not be edited; omitted for admins.
 * @param {{ maxFiles: number, maxFileBytes: number, maxTotalBytes: number }} [options.limits] Per-order
 *   limits; ORDER_LIMITS from multipartUpload.js by default.
 * @param {{ error: (message: string, details?: unknown) => void }} options.log Logger of the caller.
 * @returns {Promise<
 *   { result: "ok", order: object, removedFileIds: string[], undeletedFileIds: string[] } |
 *   { result: "not_found" } |
 *   { result: "locked" } |
 *   { result: "deleting" } |
 *   { result: "archiving", fileIds: string[] } |
 *   { result: "limit", message: string }
 * >}
 */
export async function applyOrderEdit({
	s3,
	orderID,
	ownerId,
	patient,
	details,
	dueDate,
	existingFileIds,
	knownFileIds = null,
	uploadedFileIds,
	uploadedBytes = 0,
	fileNameUpdates,
	assertEditable,
	limits = ORDER_LIMITS,
	log,
})
{
	if (!s3 || typeof s3.send !== "function")
	{
		throw new TypeError("applyOrderEdit: s3 must be an S3 client");
	}

	if (typeof orderID !== "string" || !orderID)
	{
		throw new TypeError("applyOrderEdit: orderID must be a non-empty string");
	}

	if (ownerId !== null && (typeof ownerId !== "string" || !ownerId))
	{
		throw new TypeError("applyOrderEdit: ownerId must be a non-empty string or null");
	}

	assertStringArray(existingFileIds, "existingFileIds");
	assertStringArray(uploadedFileIds, "uploadedFileIds");
	assertStringArray(fileNameUpdates, "fileNameUpdates");

	if (knownFileIds !== null)
	{
		assertStringArray(knownFileIds, "knownFileIds");
	}

	if (assertEditable !== undefined && typeof assertEditable !== "function")
	{
		throw new TypeError("applyOrderEdit: assertEditable must be a function");
	}

	if (typeof log?.error !== "function")
	{
		throw new TypeError("applyOrderEdit: log must be a logger");
	}

	if (!Number.isSafeInteger(uploadedBytes) || uploadedBytes < 0)
	{
		throw new RangeError("applyOrderEdit: uploadedBytes must be a non-negative integer");
	}

	if (
		!Number.isSafeInteger(limits?.maxFiles) ||
		!Number.isSafeInteger(limits?.maxFileBytes) ||
		!Number.isSafeInteger(limits?.maxTotalBytes)
	)
	{
		throw new TypeError("applyOrderEdit: limits must have integer maxFiles, maxFileBytes and maxTotalBytes");
	}

	let keptFileSizes = new Map();
	let earlyLimitMessage = null;

	if (uploadedFileIds.length > 0)
	{
		// Cheap early refusal that skips the S3 size lookups. It is only reported
		// under the lock, after the not-found/owner/locked checks, so those take
		// precedence; the authoritative count check also runs there.
		if (new Set(existingFileIds).size + uploadedFileIds.length > limits.maxFiles)
		{
			earlyLimitMessage = `At most ${limits.maxFiles} files per order`;
		}
		else
		{
			keptFileSizes = await readKeptFileSizes(s3, existingFileIds);
		}
	}

	const outcome = await DB.begin(async (sql) =>
	{
		const row = await selectOrderForUpdate(sql, orderID, ownerId);

		if (!row)
		{
			return { result: "not_found" };
		}

		// Also for admins: the order's files may already be partly deleted. A
		// marker older than DELETION_STALE_AFTER_MS (a delete that died) does not count.
		if (isDeletionActive(row))
		{
			return { result: "deleting" };
		}

		if (assertEditable && !assertEditable(row))
		{
			return { result: "locked" };
		}

		const currentFileIds = Array.isArray(row.files) ? row.files : [];
		const { retainedFileIds, removedFileIds } = splitFileIds(currentFileIds, existingFileIds, knownFileIds);

		// Only files that are on this order, so a client-supplied foreign file id
		// cannot show whether that file is being archived. It HEADs only the few
		// files that have a journal row, while the row lock is held.
		const archivingFileIds = await findRenamesBlockedByArchiving(
			s3,
			sql,
			parseFileRenames(patient, retainedFileIds, fileNameUpdates),
		);

		if (archivingFileIds.length > 0)
		{
			return { result: "archiving", fileIds: archivingFileIds };
		}

		if (earlyLimitMessage !== null)
		{
			return { result: "limit", message: earlyLimitMessage };
		}
		const limitMessage = orderLimitViolation({
			retainedFileIds,
			uploadedFileIds,
			uploadedBytes,
			keptFileSizes,
			limits,
		});

		if (limitMessage !== null)
		{
			return { result: "limit", message: limitMessage };
		}

		const nextFileIds = [...retainedFileIds, ...uploadedFileIds];

		// Files were added, so whatever the archiver did to this order no longer covers all of them.
		const [order] = await sql`
			UPDATE orders
			SET patient = ${patient},
				details = ${details},
				due_date = ${dueDate},
				files = ${nextFileIds}
				${uploadedFileIds.length > 0 ? sql`, archived_at = NULL` : sql``}
			WHERE order_id = ${orderID}
			RETURNING *
		`;

		return { result: "ok", order, retainedFileIds, removedFileIds };
	});

	if (outcome.result !== "ok")
	{
		return outcome;
	}

	const { order, retainedFileIds, removedFileIds } = outcome;

	try
	{
		await renameRetainedFiles(s3, patient, retainedFileIds, fileNameUpdates, { sql: DB });
	}
	catch (err)
	{
		log.error(`Order ${orderID} saved, but renaming its files failed`, err);
	}

	const undeletedFileIds = await cleanUpOrderFiles(s3, removedFileIds, {
		log,
		context: `files removed from order ${orderID}`,
	});

	return { result: "ok", order, removedFileIds, undeletedFileIds };
}
