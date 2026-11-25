import "server-only";

import { DB } from "@/app/lib/db";
import { isUuid } from "@/app/lib/validate";

// Ordering parties ("zleceniodawcy") owned by one user, sorted by name.
export async function listOrderingParties(userId)
{
	const rows = await DB`
		SELECT id, name
		FROM ordering_parties
		WHERE user_id = ${userId}
		ORDER BY name ASC
	`;

	return rows.map(({ id, name }) =>
	{
		return { id, name };
	});
}

// Returns { id, name } only when the party exists and belongs to userId.
// A malformed id is answered with null instead of reaching Postgres as a uuid error.
export async function getOwnedOrderingParty(userId, id)
{
	if (!isUuid(id))
	{
		return null;
	}

	const rows = await DB`
		SELECT id, name
		FROM ordering_parties
		WHERE id = ${id} AND user_id = ${userId}
		LIMIT 1
	`;

	if (rows.length === 0)
	{
		return null;
	}

	return { id: rows[0].id, name: rows[0].name };
}
