import { getUserAuthSession } from "@/app/server-functions/getUserAuthSession";
import { isAdminSession } from "@/app/server-functions/isAdminSession";
import {
	countArchiveCandidates,
	getArchiveJobStatus,
	startArchiveJob,
} from "@/app/server-functions/orders/orderArchiver";
import { cookies } from "next/headers";
import { internalError, jsonError } from "@/app/lib/apiErrors";
import { withRequestLogging } from "@/app/lib/withRequestLogging";
import { createLogger } from "@/app/lib/logger";

const log = createLogger("admin");

async function handleGet()
{
	try
	{
		const userAuthSession = await getUserAuthSession(await cookies());

		if (!userAuthSession.loggedIn || !isAdminSession(userAuthSession))
		{
			return jsonError("Admin access required", 403);
		}

		return Response.json({
			success: true,
			status: getArchiveJobStatus(),
			candidates: await countArchiveCandidates(),
		});
	}
	catch (err)
	{
		log.error("Failed to read archiver status", err);

		return internalError();
	}
}

async function handlePost()
{
	try
	{
		const userAuthSession = await getUserAuthSession(await cookies());

		if (!userAuthSession.loggedIn || !isAdminSession(userAuthSession))
		{
			return jsonError("Admin access required", 403);
		}

		const adminId = userAuthSession.data.identity.id;
		const { started, status } = await startArchiveJob({ triggeredBy: adminId });

		if (!started)
		{
			return Response.json(
				{ success: false, error: "Archiver is already running", status },
				{ status: 409 },
			);
		}

		log.info(`Archiver started by admin ${adminId}`);

		return Response.json({ success: true, status }, { status: 202 });
	}
	catch (err)
	{
		log.error("Failed to start archiver", err);

		return internalError();
	}
}

export const GET = withRequestLogging(handleGet);
export const POST = withRequestLogging(handlePost);
