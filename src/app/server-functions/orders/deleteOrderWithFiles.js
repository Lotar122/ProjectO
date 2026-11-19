import "server-only";

import { DB } from "@/app/lib/db";
import { deleteOrderFiles } from "@/app/server-functions/orders/orderFiles";
import { selectOrderForUpdate } from "@/app/server-functions/orders/orderRowLock";

/**
 * Deletes an order and its files while holding the order's row lock, so the
 * status check, the S3 delete and the row delete see the same order (an edit
 * or a status change waits until this finishes).
 *
 * The row stays while any of its files could not be deleted, so the order can
 * be deleted again instead of leaving patient data without an order.
 * Holding the lock during the S3 delete is fine: one order, at most a few
 * dozen objects, and `statement_timeout` applies per statement.
 *
 * @param {object} options
 * @param {object} options.s3 S3 client.
 * @param {string} options.orderID Order to delete.
 * @param {string | null} options.ownerId Owner the order must belong to; null for an admin delete.
 * @param {(row: { status: string | null }) => boolean} [options.assertDeletable] Returns false when the
 *   locked order may not be deleted; checked before any file is touched. Omitted for admins.
 * @returns {Promise<
 *   { result: "ok", fileCount: number } |
 *   { result: "not_found" } |
 *   { result: "locked" } |
 *   { result: "files_left", undeletedFileIds: string[] }
 * >}
 */
export async function deleteOrderWithFiles({ s3, orderID, ownerId, assertDeletable })
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

	return DB.begin(async (sql) =>
	{
		const row = await selectOrderForUpdate(sql, orderID, ownerId);

		if (!row)
		{
			return { result: "not_found" };
		}

		if (assertDeletable && !assertDeletable(row))
		{
			return { result: "locked" };
		}

		const fileIds = Array.isArray(row.files) ? row.files : [];
		const undeletedFileIds = await deleteOrderFiles(s3, fileIds);

		if (undeletedFileIds.length > 0)
		{
			return { result: "files_left", undeletedFileIds };
		}

		await sql`
			DELETE FROM orders
			WHERE order_id = ${orderID}
		`;

		return { result: "ok", fileCount: fileIds.length };
	});
}
