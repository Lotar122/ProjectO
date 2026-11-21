import "server-only";

import { DB } from "@/app/lib/db";
import { DELETION_STALE_INTERVAL } from "@/app/server-functions/orders/orderRowLock";

// Orders whose issue date is further back than this are archived.
export const ARCHIVE_AFTER_DAYS = 30;

// One copy of the "is this order due for archiving" predicate, shared by the
// web (candidate count) and the archiver worker (candidate list). An order
// whose deletion is running (orders.deleting_at set and younger than
// DELETION_STALE_AFTER_MS, see deleteOrderWithFiles) is not a candidate: its
// files are being deleted, and archiving them would only race the deletion.
// The stale limit is judged by the database clock, so an order left behind by
// a delete that died becomes a candidate again.

/**
 * Orders due for archiving, oldest first. journaled_files lists the files of
 * the order that still have a crash journal row (archive_pending_verify): one
 * crash recovery could not settle, or a 'needs_attention' row. The archiver
 * skips those instead of downloading and compressing them only to be refused
 * at the journal insert.
 *
 * @param {Function} [sql] postgres.js client; defaults to the shared pool.
 * @returns {Promise<{ order_id: string | number, files: string[] | null, journaled_files: string[] }[]>}
 */
export async function selectArchiveCandidates(sql = DB)
{
	return sql`
		SELECT order_id, files,
			ARRAY(
				SELECT archive_pending_verify.file_id
				FROM archive_pending_verify
				WHERE archive_pending_verify.file_id = ANY(orders.files::text[])
			) AS journaled_files
		FROM orders
		WHERE issue_date < CURRENT_DATE - ${ARCHIVE_AFTER_DAYS}::int
			AND archived_at IS NULL
			AND (orders.deleting_at IS NULL OR orders.deleting_at < now() - ${DELETION_STALE_INTERVAL}::interval)
		ORDER BY issue_date, order_id
	`;
}

/**
 * Number of orders due for archiving.
 *
 * @param {Function} [sql] postgres.js client; defaults to the shared pool.
 * @returns {Promise<number>}
 */
export async function countArchiveCandidates(sql = DB)
{
	const [row] = await sql`
		SELECT count(*)::int AS count
		FROM orders
		WHERE issue_date < CURRENT_DATE - ${ARCHIVE_AFTER_DAYS}::int
			AND archived_at IS NULL
			AND (orders.deleting_at IS NULL OR orders.deleting_at < now() - ${DELETION_STALE_INTERVAL}::interval)
	`;

	return row?.count ?? 0;
}
