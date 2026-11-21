import { cookies } from "next/headers";

import { getUserAuthSession } from "@/app/server-functions/getUserAuthSession";
import { KRATOS_TIMEOUT_MS } from "@/app/lib/kratos";
import { KRATOS_ADMIN_URL } from "@/app/lib/kratosServer";
import { isAdminSession } from "@/app/server-functions/isAdminSession";
import { sanitizeIdentity } from "../identityUtils";
import { IdentityListError, listAllIdentities } from "../listIdentities";
import { withRequestLogging } from "@/app/lib/withRequestLogging";
import { createLogger } from "@/app/lib/logger";

const log = createLogger("admin");

async function handleGet()
{
	try
	{
		const session = await getUserAuthSession(await cookies());

		if (!session.loggedIn || !isAdminSession(session))
		{
			return Response.json({ error: "Admin access required" }, { status: 403 });
		}

		const { identities, truncated } = await listAllIdentities({
			adminUrl: KRATOS_ADMIN_URL,
			timeoutMs: KRATOS_TIMEOUT_MS,
		});

		if (truncated)
		{
			log.warn(`Identity list stopped at ${identities.length} identities; Kratos still reported more pages`);
		}

		return Response.json({
			identities: identities.map(sanitizeIdentity),
			truncated,
		});
	}
	catch (error)
	{
		if (error instanceof IdentityListError)
		{
			log.error(error.message, error.details);

			const message = error.details?.payloadKeys
				? "Ory Kratos zwrócił nieprawidłową listę użytkowników."
				: "Nie udało się pobrać użytkowników z Kratos.";

			return Response.json({ error: message }, { status: 502 });
		}

		log.error("Failed to list identities", error);
		return Response.json({ error: "Nie udało się połączyć z Ory Kratos." }, { status: 502 });
	}
}

export const GET = withRequestLogging(handleGet);
