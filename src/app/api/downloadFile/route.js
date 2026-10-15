import { getUserAuthSession } from "@/app/server-functions/getUserAuthSession";
import { isAdminSession } from "@/app/server-functions/isAdminSession";
import { CHECKSUM_MISMATCH, sha256Hex } from "@/app/server-functions/MinIO/checksum";
import { createS3Client } from "@/app/server-functions/MinIO/createS3Client";
import { getFile } from "@/app/server-functions/MinIO/getFile";
import {
	ORDER_FILES_BUCKET,
	setOrderFileChecksum,
} from "@/app/server-functions/orders/orderFiles";
import { cookies } from "next/headers";
import postgres from "postgres";

export async function GET(req)
{
	const DB = postgres(process.env.DB_URL, { prepare: true, /*ssl: 'require'*/ });

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

		const [fileAccess] = isAdminSession(userAuthSession)
			? await DB`
				SELECT 1 FROM orders WHERE ${fileKey} = ANY(files) LIMIT 1
			`
			: await DB`
				SELECT 1
				FROM orders
				WHERE user_id = ${userAuthSession.data.identity.id}
					AND ${fileKey} = ANY(files)
				LIMIT 1
			`;

		if (!fileAccess)
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
		}
		else if (storedChecksum !== actualChecksum)
		{
			console.error(
				`downloadFile checksum mismatch for ${fileKey}: stored ${storedChecksum}, actual ${actualChecksum}`,
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
				"Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(file.metadata.original_name ?? "file")}`,
				"X-Content-SHA256": actualChecksum,
			},
		});

	}
	catch (err) 
	{
		console.error("downloadFile error:", err);
		return new Response(
			JSON.stringify({ error: err.message }),
			{ status: 500, headers: { "Content-Type": "application/json" } }
		);
	}
	finally 
	{
		DB.end();
	}
}
