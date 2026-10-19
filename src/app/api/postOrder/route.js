import { getUserAuthSession } from "@/app/server-functions/getUserAuthSession";
import { ChecksumMismatchError } from "@/app/server-functions/MinIO/checksum";
import { createS3Client } from "@/app/server-functions/MinIO/createS3Client";
import {
	ensureOrderFilesBucket,
	toISODate,
	uploadOrderFiles,
} from "@/app/server-functions/orders/orderFiles";
import { cookies } from "next/headers";
import { DB } from "@/app/lib/db";
import { v7 as uuid7 } from "uuid";
import { withRequestLogging } from "@/app/lib/withRequestLogging";
import { createLogger } from "@/app/lib/logger";

const log = createLogger("orders");

// Server POST function for inserting orders
async function handlePost(req)
{
	try 
	{
		// Get user session before reading the body, so anonymous requests
		// don't make the server buffer whole uploads
		const cookieHeader = await cookies();
		const userAuthSession = await getUserAuthSession(cookieHeader);

		if (!userAuthSession.loggedIn)
		{
			return new Response(JSON.stringify({ error: "Forbidden" }), {
				status: 403,
				headers: { "Content-Type": "application/json" },
			});
		}

		const formData = await req.formData();

		const patient = formData.get("patient");
		const details = formData.get("details");
		const status = formData.get("status");
		const dueDate = formData.get("dueDate");
		const issueDate = formData.get("issueDate");
		const progress = formData.get("progress");

		const files = formData.getAll("files");
		const fileChecksums = formData.getAll("fileChecksums");

		const orderID = uuid7();
		const userID = userAuthSession.data.identity.id;
		const issue_date = toISODate(issueDate);
		const due_date = toISODate(dueDate);

		const s3 = await createS3Client();
		await ensureOrderFilesBucket(s3);

		const uploadedFiles = await uploadOrderFiles(s3, files, patient, fileChecksums);
		const fileKeys = uploadedFiles.map((file) => file.fileID);

		// Insert into DB safely
		await DB`
      INSERT INTO orders (
        order_id, user_id, patient, details, status, progress, issue_date, due_date, files
      ) VALUES (
        ${orderID}, ${userID}, ${patient}, ${details}, ${status}::order_status, ${progress}, ${issue_date}, ${due_date}, ${fileKeys}
      )
    `;

		log.info(`Order ${orderID} created by ${userID} (${fileKeys.length} files)`);

		return new Response(JSON.stringify({ success: true, orderID }), {
			status: 200,
			headers: { "Content-Type": "application/json" },
		});
	}
	catch (err) 
	{
		if (err instanceof ChecksumMismatchError)
		{
			log.warn(`Upload rejected: checksum mismatch for ${err.files.length} file(s)`);
			return new Response(
				JSON.stringify({ success: false, code: err.code, error: err.message, files: err.files }),
				{ status: 422, headers: { "Content-Type": "application/json" } },
			);
		}

		log.error("Failed to create order", err);

		return new Response(
			JSON.stringify({ success: false, error: err.message }),
			{ status: 500, headers: { "Content-Type": "application/json" } },
		);
	}
}

export const POST = withRequestLogging(handlePost);
