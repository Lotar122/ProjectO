import "server-only";

import { DB } from "@/app/lib/db";

// Orders whose issue date is further back than this are archived.
export const ARCHIVE_AFTER_DAYS = 30;

// One copy of the "is this order due for archiving" predicate, shared by the
// web (candidate count) and the archiver worker (candidate list).

/**
 * Orders due for archiving, oldest first.
 *
 * @param {Function} [sql] postgres.js client; defaults to the shared pool.
 * @returns {Promise<{ order_id: string | number, files: string[] | null }[]>}
 */
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
	`;

	return row?.count ?? 0;
}
