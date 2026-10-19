import { createS3Client } from "@/app/server-functions/MinIO/createS3Client";
import { getFileMetadata } from "@/app/server-functions/MinIO/getFileMetadata";
import { decodeMetadataValue } from "@/app/server-functions/MinIO/metadataEncoding";
import { canAccessFile } from "@/app/server-functions/MinIO/verifyFileOwnership";
import { ORDER_FILES_BUCKET } from "@/app/server-functions/orders/orderFiles";

import { getUserAuthSession } from "@/app/server-functions/getUserAuthSession";

import { cookies } from "next/headers";
import { withRequestLogging } from "@/app/lib/withRequestLogging";
import { createLogger } from "@/app/lib/logger";

const log = createLogger("files");

//Has to be used with credentials
async function handleGet(req)
{
	try
	{
		const url = new URL(req.url);
		const file_id = url.searchParams.get("file_id");

		if (!file_id)
		{
			return new Response(JSON.stringify({ error: "file_id is required" }), {
				status: 400,
				headers: { "Content-Type": "application/json" },
			});
		}

		let cookieHeader = await cookies(); // get cookies from request

		let userAuthSession = await getUserAuthSession(cookieHeader);

		if (!userAuthSession.loggedIn)
		{
			return new Response(JSON.stringify({ error: "Forbidden" }), {
				status: 403,
				headers: { "Content-Type": "application/json" },
			});
		}

		if (!(await canAccessFile(userAuthSession, file_id)))
		{
			return new Response(JSON.stringify({ error: "File not found" }), {
				status: 404,
				headers: { "Content-Type": "application/json" },
			});
		}

		const s3 = await createS3Client();

		const metadata = await getFileMetadata(s3, ORDER_FILES_BUCKET, file_id);

		return new Response(JSON.stringify({ filename: decodeMetadataValue(metadata.metadata.original_name) }), {
			headers: { "Content-Type": "application/json" },
		});
	}
	catch (err)
	{
		log.error("Failed to get file name", err);
		return Response.json({ error: err.message }, { status: 500 });
	}
}

export const GET = withRequestLogging(handleGet);
