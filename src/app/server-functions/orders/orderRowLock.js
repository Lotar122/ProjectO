import "server-only";

// How long a deletion marker (orders.deleting_at) counts as a deletion still
// running. deleteOrderWithFiles clears or replaces it within one request, so a
// marker older than this was left by a request that died (process killed, the
// database unreachable at the end). Every check compares against the database
// clock (see the SQL helpers below), never the application clock, so skewed
// hosts agree; an expired marker no longer blocks edits, status changes or
// archiving, and a new delete takes it over.
export const DELETION_STALE_AFTER_MS = 15 * 60 * 1000;

// The same limit as a Postgres interval, for `now() - ${DELETION_STALE_INTERVAL}::interval`.
// Every query that treats orders.deleting_at as "a deletion is running" uses
// this one constant, so the limit has a single source:
//   running:  deleting_at >= now() - interval
//   expired or unset (not active): deleting_at IS NULL OR deleting_at < now() - interval
export const DELETION_STALE_INTERVAL = `${DELETION_STALE_AFTER_MS / 1000} seconds`;

/**
 * Reads an order and locks its row until the surrounding transaction ends, so
 * concurrent edits, deletes and status changes of the same order queue up
 * behind each other instead of working from a stale read.
 *
 * Must run on the transaction handle passed by `DB.begin`.
 *
 * @param {Function} sql Transaction handle from `DB.begin`.
 * @param {string} orderID Order to lock.
 * @param {string | null} ownerId Only lock the order when it belongs to this user; null for admins.
 * @returns {Promise<{ order_id: string, status: string | null, files: string[] | null, deleting_at: Date | null, deletion_active: boolean } | undefined>}
 *   The locked row, or undefined when there is no such order (for that owner).
 */
export async function selectOrderForUpdate(sql, orderID, ownerId)
{
	const [row] = await sql`
		SELECT order_id, status, files, deleting_at,
			(deleting_at IS NOT NULL
				AND deleting_at >= now() - ${DELETION_STALE_INTERVAL}::interval) AS deletion_active
		FROM orders
		WHERE order_id = ${orderID}
			${ownerId === null ? sql`` : sql`AND user_id = ${ownerId}`}
		FOR UPDATE
	`;

	return row;
}

/**
 * True when a deletion of the order is still running: its marker
 * (orders.deleting_at) is set and younger than DELETION_STALE_AFTER_MS, judged
 * by the database clock in `selectOrderForUpdate`. Its files may already be
 * partly gone, so the order must not be edited, have its status changed or be
 * archived; only the running delete may continue. An expired marker is not
 * active: the order is usable again and a new delete may take it over.
 *
 * @param {{ deleting_at?: Date | string | null, deletion_active?: boolean } | null | undefined} row
 *   A row from `selectOrderForUpdate`. When `deletion_active` is missing, any
 *   marker counts as active (fails closed).
 * @returns {boolean}
 */
export function isDeletionActive(row)
{
	if (typeof row?.deletion_active === "boolean")
	{
		return row.deletion_active;
	}

	return row?.deleting_at !== null && row?.deleting_at !== undefined;
}

/**
 * True when the order carries a deletion marker that has expired (a delete that
 * died). Only for logging a takeover.
 *
 * @param {{ deleting_at?: Date | string | null, deletion_active?: boolean } | null | undefined} row
 * @returns {boolean}
 */
export function hasExpiredDeletionMarker(row)
{
	return row?.deleting_at !== null && row?.deleting_at !== undefined && !isDeletionActive(row);
}
