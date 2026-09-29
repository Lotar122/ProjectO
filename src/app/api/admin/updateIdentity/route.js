"use server";

import { cookies } from "next/headers";

import { getUserAuthSession } from "@/app/server-functions/getUserAuthSession";
import { isAdminSession } from "@/app/server-functions/isAdminSession";
import { sanitizeIdentity } from "../identityUtils";

const IDENTITY_SCHEMA_ID = process.env.KRATOS_IDENTITY_SCHEMA_ID || "default";
const KRATOS_ADMIN_URL = process.env.KRATOS_ADMIN_URL || "http://kratos:4434";
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const VALID_ROLES = new Set(["user", "admin"]);

export async function PUT(request)
{
	try
	{
		const session = await getUserAuthSession(await cookies());

		if (!session.loggedIn || !isAdminSession(session))
		{
			return Response.json({ error: "Admin access required" }, { status: 403 });
		}

		const payload = await request.json();
		const id = String(payload?.id || "").trim();
		const email = String(payload?.email || "").trim().toLowerCase();
		const firstName = String(payload?.firstName || "").trim();
		const lastName = String(payload?.lastName || "").trim();
		const role = String(payload?.role || "").trim();
		const password = String(payload?.password || "");

		if (!id || !EMAIL_PATTERN.test(email))
		{
			return Response.json({ error: "Wpisz poprawny adres e-mail." }, { status: 400 });
		}

		if (!VALID_ROLES.has(role))
		{
			return Response.json({ error: "Wybierz poprawną rolę użytkownika." }, { status: 400 });
		}

		if (password && password.length < 8)
		{
			return Response.json({ error: "Hasło musi mieć co najmniej 8 znaków." }, { status: 400 });
		}

		const currentResponse = await fetch(`${KRATOS_ADMIN_URL}/admin/identities/${encodeURIComponent(id)}`, { cache: "no-store" });

		if (!currentResponse.ok)
		{
			return Response.json({ error: "Nie znaleziono użytkownika." }, { status: 404 });
		}

		const currentIdentity = await currentResponse.json();
		const traits = { email, role };

		if (firstName || lastName)
		{
			traits.name = { first: firstName, last: lastName };
		}

		const identityResponse = await fetch(`${KRATOS_ADMIN_URL}/admin/identities/${encodeURIComponent(id)}`, {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				schema_id: currentIdentity.schema_id || IDENTITY_SCHEMA_ID,
				state: currentIdentity.state,
				traits,
				...(password ? { credentials: { password: { config: { password } } } } : {}),
			}),
		});

		if (!identityResponse.ok)
		{
			let errorData = null;
			try 
			{
				errorData = await identityResponse.json(); 
			}
			catch 
			{ /* Keep a stable error response. */ }
			return Response.json({ error: errorData?.error?.reason || errorData?.error?.message || "Nie udało się zaktualizować użytkownika." }, { status: identityResponse.status >= 400 && identityResponse.status < 500 ? identityResponse.status : 502 });
		}

		return Response.json({ identity: sanitizeIdentity(await identityResponse.json()) });
	}
	catch (error)
	{
		console.error("Nie udało się zaktualizować tożsamości:", error);
		return Response.json({ error: "Nie udało się połączyć z Ory Kratos." }, { status: 502 });
	}
}
