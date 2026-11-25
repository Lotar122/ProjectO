import "server-only";

import { DB } from "@/app/lib/db";
import { createLogger } from "@/app/lib/logger";
import { deleteOrderFiles } from "@/app/server-functions/orders/orderFiles";
import {
	hasExpiredDeletionMarker,
	isDeletionActive,
	selectOrderForUpdate,
} from "@/app/server-functions/orders/orderRowLock";

const log = createLogger("orders");

// One DeleteObjects request each (S3 allows up to 1000 keys per request), so a
// request that throws only leaves the outcome of its own keys unknown.
const DELETE_CHUNK_SIZE = 1000;

// Deletes the files chunk by chunk and returns the ids that are certainly gone.
// A chunk whose request failed counts as not deleted: its ids stay on the
// order, and deleting a missing key succeeds, so the next delete attempt
// clears whatever did go through.
async function deleteFilesReportingSuccess(s3, orderID, fileIds)
{
	const deleted = new Set();

	for (let offset = 0; offset < fileIds.length; offset += DELETE_CHUNK_SIZE)
	{
		const chunk = fileIds.slice(offset, offset + DELETE_CHUNK_SIZE);

		try
		{
			const failed = new Set(await deleteOrderFiles(s3, chunk));

			chunk.filter((fileId) => !failed.has(fileId)).forEach((fileId) => deleted.add(fileId));
		}
		catch (err)
		{
			log.error(`Order ${orderID}: deleting ${chunk.length} file(s) failed`, err);
		}
	}

	return deleted;
}

// Step 3: under the row lock, drops the deleted files from the order and
// deletes the row once none is left. Otherwise the row stays with the files
// that could not be deleted and the marker is cleared, so the order is back to
// what it was (same status) minus the files that are gone, and can be edited
// or deleted again.
//
// Both writes only apply while the order still carries the marker written in
// step 1 (`marker`, the timestamp as text so no precision is lost). The
// comparison is on text too: a timestamptz parameter is serialized with
// millisecond precision, which would almost never equal the stored
// microsecond value. When a later delete took the stale marker over, it owns
// the order now: nothing is written and "deleting" is returned. The files this
// request deleted are gone from S3 either way, and the takeover deletes
// whatever is left.
function finishDeletion(orderID, ownerId, deletedFileIds, marker)
{
	return DB.begin(async (sql) =>
	{
		const row = await selectOrderForUpdate(sql, orderID, ownerId);

		if (!row)
		{
			// Only possible when a delete that took over a stale marker removed the
			// order meanwhile. The order is gone, which is what this request wanted.
			return { result: "ok", fileCount: deletedFileIds.size };
		}

		const currentFileIds = Array.isArray(row.files) ? row.files : [];
		const remainingFileIds = currentFileIds.filter((fileId) => !deletedFileIds.has(fileId));

		if (remainingFileIds.length === 0)
		{
			const deletedRows = await sql`
				DELETE FROM orders
				WHERE order_id = ${orderID}
					AND deleting_at::text = ${marker}
				RETURNING order_id
			`;

			return deletedRows.length > 0
				? { result: "ok", fileCount: deletedFileIds.size }
				: { result: "deleting" };
		}

		const updatedRows = await sql`
			UPDATE orders
			SET files = ${remainingFileIds},
				deleting_at = NULL
			WHERE order_id = ${orderID}
				AND deleting_at::text = ${marker}
			RETURNING order_id
		`;

		if (updatedRows.length === 0)
		{
			return { result: "deleting" };
		}

		return { result: "files_left", undeletedFileIds: remainingFileIds };
	});
}

/**
 * Deletes an order and its files. The database transaction is never held
 * while S3 is called, so a slow MinIO cannot tie up pool connections or keep
 * the order's row lock:
 *
 * 1. Under the row lock: check the order exists (for this owner), is not
 *    already being deleted and may be deleted; set the deletion marker
 *    (`orders.deleting_at`) and read its file list. Commit.
 * 2. Without a transaction: delete those files from S3.
 * 3. Under the row lock again: drop the deleted files from `orders.files`. When
 *    no file is left, delete the row; otherwise keep it and clear the marker,
 *    so it never lists a file that is gone and never disappears while files
 *    remain (they can be deleted by trying again instead of leaving patient
 *    data without an order). Only while the order still carries the marker
 *    step 1 wrote; if a later delete took it over, nothing is written and the
 *    result is "deleting".
 *
 * While the marker is set, edits (applyOrderEdit), admin status changes and
 * other deletes refuse the order with a 409, and the archiver skips it. So the
 * order cannot gain files or leave a deletable status between steps 1 and 3,
 * and the permission check of step 1 holds for the whole deletion: step 3 does
 * not check it again.
 *
 * The status is never touched; a failed deletion only clears the marker. A
 * marker the request could not clear (the process died, or the database failed
 * at step 3 twice) stays and blocks edits of the half-deleted order; after
 * DELETION_STALE_AFTER_MS (compared on the database clock) the marker no longer
 * blocks anything: edits, status changes and archiving proceed, and a new
 * delete takes it over and finishes the job.
 *
 * @param {object} options
 * @param {object} options.s3 S3 client.
 * @param {string} options.orderID Order to delete.
 * @param {string | null} options.ownerId Owner the order must belong to; null for an admin delete.
 * @param {(row: { status: string | null }) => boolean} [options.assertDeletable] Returns false when the
 *   locked order may not be deleted; checked once, before the marker is set and any file is
 *   touched. Omitted for admins.
 * @param {(fileIds: string[]) => Promise<string[]>} [options.cleanupDeletedFiles] Runs after the files
 *   are gone from S3 and before the order row is finalised, with the ids deleted (read under the
 *   lock, so they are complete). Returns the ids it could not clean up; those stay on the order
 *   like undeleted files, so a later delete finds them again. A throw counts as all ids failed.
 * @returns {Promise<
 *   { result: "ok", fileCount: number } |
 *   { result: "not_found" } |
 *   { result: "locked" } |
 *   { result: "deleting" } |
 *   { result: "files_left", undeletedFileIds: string[] }
 * >} "deleting" when another delete of the order is still running, or took over
 *   this one's expired marker before step 3.
 */
export async function deleteOrderWithFiles({ s3, orderID, ownerId, assertDeletable, cleanupDeletedFiles })
{
	if (!s3 || typeof s3.send !== "function")
	{
		throw new TypeError("deleteOrderWithFiles: s3 must be an S3 client");
	}

	if (typeof orderID !== "string" || !orderID)
	{
		throw new TypeError("deleteOrderWithFiles: orderID must be a non-empty string");
	}

	if (ownerId !== null && (typeof ownerId !== "string" || !ownerId))
	{
		throw new TypeError("deleteOrderWithFiles: ownerId must be a non-empty string or null");
	}

	if (assertDeletable !== undefined && typeof assertDeletable !== "function")
	{
		throw new TypeError("deleteOrderWithFiles: assertDeletable must be a function");
	}

	if (cleanupDeletedFiles !== undefined && typeof cleanupDeletedFiles !== "function")
	{
		throw new TypeError("deleteOrderWithFiles: cleanupDeletedFiles must be a function");
	}

	const snapshot = await DB.begin(async (sql) =>
	{
		const row = await selectOrderForUpdate(sql, orderID, ownerId);

		if (!row)
		{
			return { result: "not_found" };
		}

		if (isDeletionActive(row))
		{
			return { result: "deleting" };
		}

		if (assertDeletable && !assertDeletable(row))
		{
			return { result: "locked" };
		}

		if (hasExpiredDeletionMarker(row))
		{
			log.warn(`Order ${orderID}: taking over a stale deletion marker from ${new Date(row.deleting_at).toISOString()}`);
		}

		const [marked] = await sql`
			UPDATE orders
			SET deleting_at = now()
			WHERE order_id = ${orderID}
			RETURNING deleting_at::text AS marker
		`;

		return { result: "ok", marker: marked.marker, fileIds: Array.isArray(row.files) ? row.files : [] };
	});

	if (snapshot.result !== "ok")
	{
		return snapshot;
	}

	const deletedFileIds = await deleteFilesReportingSuccess(s3, orderID, snapshot.fileIds);

	if (cleanupDeletedFiles && deletedFileIds.size > 0)
	{
		let uncleaned;

		try
		{
			uncleaned = await cleanupDeletedFiles([...deletedFileIds]);
		}
		catch (err)
		{
			log.error(`Order ${orderID}: cleaning up after the deleted files failed: ${err?.message}`);
			uncleaned = [...deletedFileIds];
		}

		uncleaned.forEach((fileId) => deletedFileIds.delete(fileId));
	}

	try
	{
		return await finishDeletion(orderID, ownerId, deletedFileIds, snapshot.marker);
	}
	catch (err)
	{
		// The marker must not outlive this request if the database lets us
		// clear it: one more try, then the stale-marker takeover is the fallback.
		log.warn(`Order ${orderID}: finishing the deletion failed, retrying once: ${err.message}`);

		return finishDeletion(orderID, ownerId, deletedFileIds, snapshot.marker);
	}
}
