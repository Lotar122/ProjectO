"use server";

import { cookies } from "next/headers";

import { getUserAuthSession } from "@/app/server-functions/getUserAuthSession";
import { isAdminSession } from "@/app/server-functions/isAdminSession";
import { sanitizeIdentity } from "../identityUtils";

const KRATOS_ADMIN_URL = process.env.KRATOS_ADMIN_URL || "http://kratos:4434";

export async function GET()
{
	try
	{
		const session = await getUserAuthSession(await cookies());

		if (!session.loggedIn || !isAdminSession(session))
		{
			return Response.json({ error: "Admin access required" }, { status: 403 });
		}

		const response = await fetch(
			`${KRATOS_ADMIN_URL}/admin/identities?page=1&per_page=500`,
			{ cache: "no-store" },
		);

		if (!response.ok)
		{
			return Response.json({ error: "Nie udało się pobrać użytkowników z Kratos." }, { status: 502 });
		}

		const identities = await response.json();

		return Response.json({
			identities: Array.isArray(identities)
				? identities.map(sanitizeIdentity)
				: [],
		});
	}
	catch (error)
	{
		console.error("Nie udało się pobrać tożsamości:", error);
		return Response.json({ error: "Nie udało się połączyć z Ory Kratos." }, { status: 502 });
	}
}
