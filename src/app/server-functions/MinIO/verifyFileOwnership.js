import "server-only";

import { DB } from "@/app/lib/db";
import { isAdminSession } from "@/app/server-functions/isAdminSession";

// Returns the subset of fileIds the session may access. Takes an already
// resolved session so callers don't hit Kratos again per file.
export async function getAccessibleFileIds(userAuthSession, fileIds)
{
	if (!userAuthSession?.loggedIn || fileIds.length === 0)
	{
		return new Set();
	}

	const rows = isAdminSession(userAuthSession)
		? await DB`
			SELECT DISTINCT file_id
			FROM orders, unnest(files) AS file_id
			WHERE file_id IN ${DB(fileIds)}
		`
		: await DB`
			SELECT DISTINCT file_id
			FROM orders, unnest(files) AS file_id
			WHERE user_id = ${userAuthSession.data.identity.id}
				AND file_id IN ${DB(fileIds)}
		`;

	return new Set(rows.map((row) => String(row.file_id)));
}

export async function canAccessFile(userAuthSession, fileId)
{
	return (await getAccessibleFileIds(userAuthSession, [fileId])).has(fileId);
}
