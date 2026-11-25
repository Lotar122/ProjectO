import { cookies } from "next/headers";
import { v7 as uuid7 } from "uuid";

import { DB } from "@/app/lib/db";
import { describeDbError } from "@/app/lib/dbError";
import { getUserAuthSession } from "@/app/server-functions/getUserAuthSession";
import { isAdminSession } from "@/app/server-functions/isAdminSession";
import { MAX_ORDERING_PARTY_NAME_LENGTH, isUuid, readText } from "@/app/lib/validate";
import { withRequestLogging } from "@/app/lib/withRequestLogging";
import { createLogger } from "@/app/lib/logger";

const log = createLogger("admin");

const UNIQUE_VIOLATION = "23505";
const FORBIDDEN_MESSAGE = "Admin access required";

// Returns the session when the caller is an admin, otherwise null.
async function getAdminSession()
{
	const session = await getUserAuthSession(await cookies());

	return session.loggedIn && isAdminSession(session) ? session : null;
}

async function readJson(request)
{
	try
	{
		return await request.json();
	}
	catch
	{
		return undefined;
	}
}

// Logs the failure without the error object: Postgres details can contain names.
function databaseFailure(error, action)
{
	log.error(`Failed to ${action} ordering party: ${describeDbError(error)}`);

	return Response.json({ error: "Nie udało się przetworzyć zleceniodawcy." }, { status: 500 });
}

function duplicateResponse()
{
	return Response.json({ error: "Ten zleceniodawca już istnieje." }, { status: 409 });
}

function notFoundResponse()
{
	return Response.json({ error: "Nie znaleziono zleceniodawcy." }, { status: 404 });
}

function invalidNameResponse()
{
	return Response.json({ error: `Nazwa zleceniodawcy musi mieć od 1 do ${MAX_ORDERING_PARTY_NAME_LENGTH} znaków.` }, { status: 400 });
}

async function handleGet(request)
{
	try
	{
		if (!(await getAdminSession()))
		{
			return Response.json({ error: FORBIDDEN_MESSAGE }, { status: 403 });
		}

		const userId = new URL(request.url).searchParams.get("userId")?.trim();

		if (!isUuid(userId))
		{
			return Response.json({ error: "Nieprawidłowy identyfikator użytkownika." }, { status: 400 });
		}

		const orderingParties = await DB`
			SELECT id, name
			FROM ordering_parties
			WHERE user_id = ${userId}
			ORDER BY name
		`;

		return Response.json({ orderingParties });
	}
	catch (error)
	{
		return databaseFailure(error, "list");
	}
}

async function handlePost(request)
{
	try
	{
		const session = await getAdminSession();

		if (!session)
		{
			return Response.json({ error: FORBIDDEN_MESSAGE }, { status: 403 });
		}

		const payload = await readJson(request);

		if (payload === undefined)
		{
			return Response.json({ error: "Nieprawidłowe dane formularza." }, { status: 400 });
		}

		const userId = String(payload?.userId ?? "").trim();
		const name = readText(payload?.name, MAX_ORDERING_PARTY_NAME_LENGTH);

		if (!isUuid(userId))
		{
			return Response.json({ error: "Nieprawidłowy identyfikator użytkownika." }, { status: 400 });
		}

		if (!name)
		{
			return invalidNameResponse();
		}

		const id = uuid7();

		await DB`
			INSERT INTO ordering_parties (id, user_id, name)
			VALUES (${id}, ${userId}, ${name})
		`;

		log.info(`Ordering party ${id} created for identity ${userId} by admin ${session.data.identity.id}`);

		return Response.json({ orderingParty: { id, name } }, { status: 201 });
	}
	catch (error)
	{
		if (error?.code === UNIQUE_VIOLATION)
		{
			return duplicateResponse();
		}

		return databaseFailure(error, "create");
	}
}

async function handlePut(request)
{
	try
	{
		const session = await getAdminSession();

		if (!session)
		{
			return Response.json({ error: FORBIDDEN_MESSAGE }, { status: 403 });
		}

		const payload = await readJson(request);

		if (payload === undefined)
		{
			return Response.json({ error: "Nieprawidłowe dane formularza." }, { status: 400 });
		}

		const id = String(payload?.id ?? "").trim();
		const name = readText(payload?.name, MAX_ORDERING_PARTY_NAME_LENGTH);

		if (!isUuid(id))
		{
			return Response.json({ error: "Nieprawidłowy identyfikator zleceniodawcy." }, { status: 400 });
		}

		if (!name)
		{
			return invalidNameResponse();
		}

		const rows = await DB`
			UPDATE ordering_parties
			SET name = ${name}
			WHERE id = ${id}
			RETURNING id, name
		`;

		if (rows.length === 0)
		{
			return notFoundResponse();
		}

		log.info(`Ordering party ${id} renamed by admin ${session.data.identity.id}`);

		return Response.json({ orderingParty: rows[0] });
	}
	catch (error)
	{
		if (error?.code === UNIQUE_VIOLATION)
		{
			return duplicateResponse();
		}

		return databaseFailure(error, "update");
	}
}

async function handleDelete(request)
{
	try
	{
		const session = await getAdminSession();

		if (!session)
		{
			return Response.json({ error: FORBIDDEN_MESSAGE }, { status: 403 });
		}

		const id = new URL(request.url).searchParams.get("id")?.trim();

		if (!isUuid(id))
		{
			return Response.json({ error: "Nieprawidłowy identyfikator zleceniodawcy." }, { status: 400 });
		}

		// Orders keep their copied party name; their ordering_party_id is cleared by the foreign key.
		const rows = await DB`
			DELETE FROM ordering_parties
			WHERE id = ${id}
			RETURNING id
		`;

		if (rows.length === 0)
		{
			return notFoundResponse();
		}

		log.info(`Ordering party ${id} deleted by admin ${session.data.identity.id}`);

		return Response.json({ success: true });
	}
	catch (error)
	{
		return databaseFailure(error, "delete");
	}
}

export const GET = withRequestLogging(handleGet);
export const POST = withRequestLogging(handlePost);
export const PUT = withRequestLogging(handlePut);
export const DELETE = withRequestLogging(handleDelete);
