"use server";

import { cookies } from "next/headers";
import postgres from "postgres";

import { getUserAuthSession } from "@/app/server-functions/getUserAuthSession";
import { isAdminSession } from "@/app/server-functions/isAdminSession";

const KRATOS_ADMIN_URL = process.env.KRATOS_ADMIN_URL || "http://kratos:4434";

export async function DELETE(request)
{
	let DB = null;

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
		});

		if (!response.ok)
		{
			return Response.json({ error: response.status === 404 ? "Nie znaleziono użytkownika." : "Nie udało się usunąć użytkownika z Ory Kratos." }, { status: response.status === 404 ? 404 : 502 });
		}

		// The application user row is no longer needed after the Kratos identity is gone.
		// Orders are intentionally retained and become unassigned in the admin order view.
		DB = postgres(process.env.DB_URL, { prepare: true });
		await DB`DELETE FROM users WHERE user_id = ${id}`;

		return Response.json({ success: true });
	}
	catch (error)
	{
		console.error("Nie udało się usunąć tożsamości:", error);
		return Response.json({ error: "Nie udało się usunąć użytkownika." }, { status: 502 });
	}
	finally
	{
		await DB?.end();
	}
}
