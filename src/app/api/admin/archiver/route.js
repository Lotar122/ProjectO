import { getUserAuthSession } from "@/app/server-functions/getUserAuthSession";
import { isAdminSession } from "@/app/server-functions/isAdminSession";
import { countArchiveCandidates } from "@/app/server-functions/orders/archiveCandidates";
import {
	ARCHIVER_BUSY,
	ARCHIVER_WORKER_OFFLINE,
	enqueueArchiveJob,
	getArchiveStatus,
} from "@/app/server-functions/orders/archiveJobs";
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

		const [archive, candidates] = await Promise.all([
			getArchiveStatus(),
			countArchiveCandidates(),
		]);

		return Response.json({ success: true, ...archive, candidates });
	}
	catch (err)
	{
		log.error("Failed to read archiver status", err);

		return internalError();
	}
}

// The job is already queued (or already active) when this runs, so a failed
// status read must not turn the response into a 500 that hides that.
async function readStatusAfterEnqueue()
{
	try
	{
		return (await getArchiveStatus()).status;
	}
	catch (err)
	{
		log.warn(`Could not read archiver status after enqueue: ${err.message}`);

		return null;
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
		const result = await enqueueArchiveJob({ triggeredBy: adminId });

		if (!result.queued && result.reason === "worker-offline")
		{
			return Response.json(
				{ success: false, code: ARCHIVER_WORKER_OFFLINE, error: "Archiver worker is offline" },
				{ status: 503 },
			);
		}

		const status = await readStatusAfterEnqueue();

		if (!result.queued)
		{
			return Response.json(
				{ success: false, code: ARCHIVER_BUSY, error: "Archiver is already running", status },
				{ status: 409 },
			);
		}

		log.info(`Archiver job ${result.jobId} queued by admin ${adminId}`);

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
