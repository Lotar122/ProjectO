import { cookies } from "next/headers";

import { getUserAuthSession } from "@/app/server-functions/getUserAuthSession";
import { KRATOS_TIMEOUT_MS } from "@/app/lib/kratos";
import { isAdminSession } from "@/app/server-functions/isAdminSession";
import { isUuid } from "@/app/lib/validate";
import { sanitizeIdentity } from "../identityUtils";
import { withRequestLogging } from "@/app/lib/withRequestLogging";
import { createLogger } from "@/app/lib/logger";

const log = createLogger("admin");

const IDENTITY_SCHEMA_ID = process.env.KRATOS_IDENTITY_SCHEMA_ID || "default";
const KRATOS_ADMIN_URL = process.env.KRATOS_ADMIN_URL || "http://kratos:4434";
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const VALID_ROLES = new Set(["user", "admin"]);

async function handlePut(request)
{
	try
	{
		const session = await getUserAuthSession(await cookies());

		if (!session.loggedIn || !isAdminSession(session))
		{
			return Response.json({ error: "Admin access required" }, { status: 403 });
		}

		let payload;

		try
		{
			payload = await request.json();
		}
		catch
		{
			return Response.json({ error: "Nieprawidłowe dane formularza." }, { status: 400 });
		}

		const id = String(payload?.id || "").trim();
		const email = String(payload?.email || "").trim().toLowerCase();
		const firstName = String(payload?.firstName || "").trim();
		const lastName = String(payload?.lastName || "").trim();
		const role = String(payload?.role || "").trim();
		const password = String(payload?.password || "");

		if (!isUuid(id) || !EMAIL_PATTERN.test(email))
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

		const currentResponse = await fetch(`${KRATOS_ADMIN_URL}/admin/identities/${encodeURIComponent(id)}`, { cache: "no-store", signal: AbortSignal.timeout(KRATOS_TIMEOUT_MS) });

		if (!currentResponse.ok)
		{
			log.warn(`Kratos lookup for identity ${id} returned ${currentResponse.status}`);
			return Response.json({ error: "Nie znaleziono użytkownika." }, { status: 404 });
		}

		if (id === session.data.identity.id && role !== "admin")
		{
			return Response.json({ error: "Nie możesz odebrać sobie roli administratora." }, { status: 400 });
		}

		const currentIdentity = await currentResponse.json();
		// Keep traits the form doesn't edit; traits.role is only a mirror for
		// identity schemas that still require it (see isAdminSession).
		const traits = { ...currentIdentity.traits, email, role };

		if (firstName || lastName)
		{
			traits.name = { first: firstName, last: lastName };
		}
		else
		{
			delete traits.name;
		}

		const identityResponse = await fetch(`${KRATOS_ADMIN_URL}/admin/identities/${encodeURIComponent(id)}`, {
			method: "PUT",
			signal: AbortSignal.timeout(KRATOS_TIMEOUT_MS),
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				schema_id: currentIdentity.schema_id || IDENTITY_SCHEMA_ID,
				state: currentIdentity.state,
				traits,
				metadata_public: { ...currentIdentity.metadata_public, role },
				metadata_admin: currentIdentity.metadata_admin,
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
			log.warn(`Kratos rejected update of identity ${id}: ${identityResponse.status} ${errorData?.error?.reason || errorData?.error?.message || ""}`);
			return Response.json({ error: errorData?.error?.reason || errorData?.error?.message || "Nie udało się zaktualizować użytkownika." }, { status: identityResponse.status >= 400 && identityResponse.status < 500 ? identityResponse.status : 502 });
		}

		if (password && id !== session.data.identity.id)
		{
			// A new password must also end the sessions opened with the old one.
			const revokeResponse = await fetch(`${KRATOS_ADMIN_URL}/admin/identities/${encodeURIComponent(id)}/sessions`, {
				method: "DELETE",
				signal: AbortSignal.timeout(KRATOS_TIMEOUT_MS),
			}).catch(() => null);

			if (!revokeResponse?.ok && revokeResponse?.status !== 404)
			{
				log.warn(`Could not revoke sessions of identity ${id} after password change`);
			}
		}

		log.info(`Identity ${id} updated by admin ${session.data.identity.id} (role ${role}${password ? ", password changed" : ""})`);

		return Response.json({ identity: sanitizeIdentity(await identityResponse.json()) });
	}
	catch (error)
	{
		log.error("Failed to update identity", error);
		return Response.json({ error: "Nie udało się połączyć z Ory Kratos." }, { status: 502 });
	}
}

export const PUT = withRequestLogging(handlePut);
