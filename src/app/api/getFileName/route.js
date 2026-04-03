"use server";

import { createS3Client } from "@/app/server-functions/MinIO/createS3Client";
import { getFileMetadata } from "@/app/server-functions/MinIO/getFileMetadata";

import { getUserAuthSession } from "@/app/server-functions/getUserAuthSession";

import { cookies } from "next/headers";

//Has to be used with credentials
export async function GET(req) {
	let payload = null;

	const url = new URL(req.url);

  	const file_id = url.searchParams.get("file_id");

	console.log(file_id);

	let cookieHeader = await cookies(); // get cookies from request

	let userAuthSession = await getUserAuthSession(cookieHeader);

	if (!userAuthSession.loggedIn) {
		return new Response(JSON.stringify({ error: "Forbidden" }), {
			status: 403,
			headers: { "Content-Type": "application/json" },
		});
	}

	const s3 = await createS3Client();

	const metadata = await getFileMetadata(s3, "projecto", file_id);

	payload = { filename: metadata.metadata.original_name };

	return new Response(JSON.stringify(payload), {
		headers: { "Content-Type": "application/json" },
	});
}
