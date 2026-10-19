import { getUserAuthSession } from "@/app/server-functions/getUserAuthSession";
import { CHECKSUM_MISMATCH, sha256Hex } from "@/app/server-functions/MinIO/checksum";
import { createS3Client } from "@/app/server-functions/MinIO/createS3Client";
import { getFile } from "@/app/server-functions/MinIO/getFile";
import { decodeMetadataValue } from "@/app/server-functions/MinIO/metadataEncoding";
import { canAccessFile } from "@/app/server-functions/MinIO/verifyFileOwnership";
import {
	ORDER_FILES_BUCKET,
	setOrderFileChecksum,
} from "@/app/server-functions/orders/orderFiles";
import { cookies } from "next/headers";
import { withRequestLogging } from "@/app/lib/withRequestLogging";
import { createLogger } from "@/app/lib/logger";

const log = createLogger("files");

async function handleGet(req)
{
	try 
	{
		const { searchParams } = new URL(req.url);
		const fileKey = searchParams.get("file_id");

		if (!fileKey)
		{
			return new Response(JSON.stringify({ error: "file_id is required" }), {
				status: 400,
				headers: { "Content-Type": "application/json" },
			});
		}

		// Auth check
		const cookieHeader = await cookies();
		const userAuthSession = await getUserAuthSession(cookieHeader);

		if (!userAuthSession.loggedIn)
		{
			return new Response(JSON.stringify({ error: "Forbidden" }), {
				status: 403,
				headers: { "Content-Type": "application/json" },
			});
		}

		if (!(await canAccessFile(userAuthSession, fileKey)))
		{
			return new Response(JSON.stringify({ error: "File not found" }), {
				status: 404,
				headers: { "Content-Type": "application/json" },
			});
		}

		const s3 = await createS3Client();

		// Fetch file from MinIO
		const file = await getFile(s3, ORDER_FILES_BUCKET, fileKey);

		const actualChecksum = sha256Hex(file.data);
		const storedChecksum = file.metadata?.sha256;

		if (!storedChecksum)
		{
			// Legacy file uploaded before checksumming - backfill on first download
			await setOrderFileChecksum(s3, fileKey, actualChecksum);
			log.info(`Backfilled checksum for legacy file ${fileKey}`);
		}
		else if (storedChecksum !== actualChecksum)
		{
			log.error(
				`Checksum mismatch for file ${fileKey}: stored ${storedChecksum}, actual ${actualChecksum}`,
			);
			return new Response(
				JSON.stringify({ error: "File integrity check failed", code: CHECKSUM_MISMATCH }),
				{ status: 500, headers: { "Content-Type": "application/json" } },
			);
		}

		return new Response(file.data, {
			status: 200,
			headers: {
				"Content-Type": file.contentType ?? "application/octet-stream",
				"Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(decodeMetadataValue(file.metadata.original_name) ?? "file")}`,
				"X-Content-SHA256": actualChecksum,
			},
		});

	}
	catch (err) 
	{
		log.error("Failed to download file", err);
		return new Response(
			JSON.stringify({ error: err.message }),
			{ status: 500, headers: { "Content-Type": "application/json" } }
		);
	}
}

export const GET = withRequestLogging(handleGet);
