"use server";

import { createS3Client } from "@/app/server-functions/MinIO/createS3Client";
import { getFileMetadata } from "@/app/server-functions/MinIO/getFileMetadata"

//Has to be used with credentials
export async function GET(req) {
	let payload = null;

	const body = await req.json();

  	const { file_id } = body;

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
