"use server";

import { createS3Client } from "@/app/server-functions/MinIO/createS3Client";
import { getFileMetadata } from "@/app/server-functions/MinIO/getFileMetadata";

import { getUserAuthSession } from "@/app/server-functions/getUserAuthSession";

import { cookies } from "next/headers";
import postgres from "postgres";

//Has to be used with credentials
export async function GET(req)
{
	let payload = null;
	let DB = null;

	try {
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

		DB = postgres(process.env.DB_URL, { prepare: true, ssl: "require" });

		const [fileAccess] = await DB`
			SELECT 1
			FROM orders
			WHERE user_id = ${userAuthSession.data.identity.id}
				AND ${file_id} = ANY(files)
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

		const metadata = await getFileMetadata(s3, "projecto", file_id);

		payload = { filename: metadata.metadata.original_name };

		return new Response(JSON.stringify(payload), {
			headers: { "Content-Type": "application/json" },
		});
	} finally {
		await DB?.end();
	}
}
