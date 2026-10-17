import { cookies } from "next/headers";

import { getUserAuthSession } from "@/app/server-functions/getUserAuthSession";
import { KRATOS_TIMEOUT_MS } from "@/app/lib/kratos";
import { isAdminSession } from "@/app/server-functions/isAdminSession";
import { sanitizeIdentity } from "../identityUtils";
import { withRequestLogging } from "@/app/lib/withRequestLogging";
import { createLogger } from "@/app/lib/logger";

const log = createLogger("admin");

const KRATOS_ADMIN_URL = process.env.KRATOS_ADMIN_URL || "http://kratos:4434";

async function handleGet()
{
	try
	{
		const session = await getUserAuthSession(await cookies());

		if (!session.loggedIn || !isAdminSession(session))
		{
			return Response.json({ error: "Admin access required" }, { status: 403 });
		}

		const response = await fetch(
			`${KRATOS_ADMIN_URL}/admin/identities?page_size=500`,
			{
				cache: "no-store",
				signal: AbortSignal.timeout(KRATOS_TIMEOUT_MS),
				headers: {
					Accept: "application/json",
				},
			},
		);

		if (!response.ok)
		{
			log.error(`Kratos identity list returned ${response.status}`);
			return Response.json({ error: "Nie udało się pobrać użytkowników z Kratos." }, { status: 502 });
		}

		const payload = await response.json();
		const identities = Array.isArray(payload)
			? payload
			: payload?.identities || payload?.data?.identities || payload?.data;

		if (!Array.isArray(identities))
		{
			log.error("Unexpected identity list format from Kratos", {
				status: response.status,
				payloadKeys: payload && typeof payload === "object" ? Object.keys(payload) : [],
			});
			return Response.json({ error: "Ory Kratos zwrócił nieprawidłową listę użytkowników." }, { status: 502 });
		}

		return Response.json({
			identities: identities.map(sanitizeIdentity),
		});
	}
	catch (error)
	{
		log.error("Failed to list identities", error);
		return Response.json({ error: "Nie udało się połączyć z Ory Kratos." }, { status: 502 });
	}
}

export const GET = withRequestLogging(handleGet);
