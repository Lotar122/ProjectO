import { cookies } from "next/headers";
import { DB } from "@/app/lib/db";

import { getUserAuthSession } from "@/app/server-functions/getUserAuthSession";
import { KRATOS_TIMEOUT_MS } from "@/app/lib/kratos";
import { isAdminSession } from "@/app/server-functions/isAdminSession";
import { withRequestLogging } from "@/app/lib/withRequestLogging";
import { createLogger } from "@/app/lib/logger";

const log = createLogger("admin");

const KRATOS_ADMIN_URL = process.env.KRATOS_ADMIN_URL || "http://kratos:4434";

async function handleDelete(request)
{
	try
	{
		const session = await getUserAuthSession(await cookies());

		if (!session.loggedIn || !isAdminSession(session))
		{
			return Response.json({ error: "Admin access required" }, { status: 403 });
		}

		const id = new URL(request.url).searchParams.get("id")?.trim();

		if (!id)
		{
			return Response.json({ error: "Identity id is required" }, { status: 400 });
		}

		if (id === session.data.identity.id)
		{
			return Response.json({ error: "Nie możesz usunąć własnego konta administratora." }, { status: 400 });
		}

		const response = await fetch(`${KRATOS_ADMIN_URL}/admin/identities/${encodeURIComponent(id)}`, {
			method: "DELETE",
			signal: AbortSignal.timeout(KRATOS_TIMEOUT_MS),
		});

		if (!response.ok)
		{
			log.warn(`Kratos rejected deletion of identity ${id}: ${response.status}`);
			return Response.json({ error: response.status === 404 ? "Nie znaleziono użytkownika." : "Nie udało się usunąć użytkownika z Ory Kratos." }, { status: response.status === 404 ? 404 : 502 });
		}

		// The application user row is no longer needed after the Kratos identity is gone.
		// Orders are intentionally retained and become unassigned in the admin order view.
		await DB`DELETE FROM users WHERE user_id = ${id}`;

		log.info(`Identity ${id} deleted by admin ${session.data.identity.id}`);

		return Response.json({ success: true });
	}
	catch (error)
	{
		log.error("Failed to delete identity", error);
		return Response.json({ error: "Nie udało się usunąć użytkownika." }, { status: 502 });
	}
}

export const DELETE = withRequestLogging(handleDelete);
