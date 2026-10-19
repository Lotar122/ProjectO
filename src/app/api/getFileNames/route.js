import { createS3Client } from "@/app/server-functions/MinIO/createS3Client";
import { getFileMetadata } from "@/app/server-functions/MinIO/getFileMetadata";
import { decodeMetadataValue } from "@/app/server-functions/MinIO/metadataEncoding";
import { getAccessibleFileIds } from "@/app/server-functions/MinIO/verifyFileOwnership";
import { ORDER_FILES_BUCKET } from "@/app/server-functions/orders/orderFiles";

import { getUserAuthSession } from "@/app/server-functions/getUserAuthSession";

import { cookies } from "next/headers";
import { withRequestLogging } from "@/app/lib/withRequestLogging";
import { createLogger } from "@/app/lib/logger";
import { mapWithConcurrency } from "@/app/lib/concurrency";
import { internalError } from "@/app/lib/apiErrors";
import { isUuid } from "@/app/lib/validate";

const log = createLogger("files");

const MAX_FILE_IDS = 200;
const S3_CONCURRENCY = 8;

// Batch version of getFileName: one auth check and one DB query for the whole
// page instead of one request (and Kratos + DB round trip) per attachment.
//Has to be used with credentials
async function handlePost(req)
{
	try
	{
		const userAuthSession = await getUserAuthSession(await cookies());

		if (!userAuthSession.loggedIn)
		{
			return Response.json({ error: "Forbidden" }, { status: 403 });
		}

		let payload;

		try
		{
			payload = await req.json();
		}
		catch
		{
			return Response.json({ error: "Invalid JSON body" }, { status: 400 });
		}

		const fileIds = [
			...new Set(
				(Array.isArray(payload?.fileIds) ? payload.fileIds : [])
					.map((fileId) => String(fileId ?? "").trim())
					.filter(isUuid),
			),
		];

		if (fileIds.length === 0)
		{
			return Response.json({ filenames: {} });
		}

		if (fileIds.length > MAX_FILE_IDS)
		{
			return Response.json(
				{ error: `At most ${MAX_FILE_IDS} fileIds per request` },
				{ status: 400 },
			);
		}

		const accessibleFileIds = await getAccessibleFileIds(userAuthSession, fileIds);
		const s3 = await createS3Client();

		const entries = await mapWithConcurrency(
			fileIds.filter((fileId) => accessibleFileIds.has(fileId)),
			S3_CONCURRENCY,
			async (fileId) =>
			{
				try
				{
					const metadata = await getFileMetadata(s3, ORDER_FILES_BUCKET, fileId);
					return [fileId, decodeMetadataValue(metadata.metadata?.original_name) ?? null];
				}
				catch (err)
				{
					// One missing object shouldn't fail the names for the whole page.
					log.warn(`Metadata lookup failed for file ${fileId}: ${err.message}`);
					return [fileId, null];
				}
			},
		);

		return Response.json({ filenames: Object.fromEntries(entries) });
	}
	catch (err)
	{
		log.error("Failed to get file names", err);
		return internalError();
	}
}

export const POST = withRequestLogging(handlePost);
