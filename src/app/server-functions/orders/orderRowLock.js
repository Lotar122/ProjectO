import "server-only";

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
 * @returns {Promise<{ order_id: string, status: string | null, files: string[] | null } | undefined>}
 *   The locked row, or undefined when there is no such order (for that owner).
 */
export async function selectOrderForUpdate(sql, orderID, ownerId)
{
	const [row] = await sql`
		SELECT order_id, status, files
		FROM orders
		WHERE order_id = ${orderID}
			${ownerId === null ? sql`` : sql`AND user_id = ${ownerId}`}
		FOR UPDATE
	`;

	return row;
}
