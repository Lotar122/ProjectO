"use server";

import { getUserAuthSession } from "@/app/server-functions/getUserAuthSession";
import { createS3Client } from "@/app/server-functions/MinIO/createS3Client";
import {
	ensureOrderFilesBucket,
	toISODate,
	uploadOrderFiles,
} from "@/app/server-functions/orders/orderFiles";
import { cookies } from "next/headers";
import postgres from "postgres";
import { v7 as uuid7 } from "uuid";

// Server POST function for inserting orders
export async function POST(req)
{
	const DB = postgres(process.env.DB_URL, { prepare: true, ssl: 'require' });

	try {
		const formData = await req.formData();

		const patient = formData.get("patient");
		const details = formData.get("details");
		const status = formData.get("status");
		const dueDate = formData.get("dueDate");
		const issueDate = formData.get("issueDate");
		const progress = formData.get("progress");

		const files = formData.getAll("files");

		// Get user session
		const cookieHeader = await cookies();
		const userAuthSession = await getUserAuthSession(cookieHeader);

		if (!userAuthSession.loggedIn)
		{
			return new Response(JSON.stringify({ error: "Forbidden" }), {
				status: 403,
				headers: { "Content-Type": "application/json" },
			});
		}

		const orderID = uuid7();
		const userID = userAuthSession.data.identity.id;
		const issue_date = toISODate(issueDate);
		const due_date = toISODate(dueDate);

		const s3 = await createS3Client();
		await ensureOrderFilesBucket(s3);

		const uploadedFiles = await uploadOrderFiles(s3, files, patient);
		const fileKeys = uploadedFiles.map((file) => file.fileID);

		// Insert into DB safely
		await DB`
      INSERT INTO orders (
        order_id, user_id, patient, details, status, progress, issue_date, due_date, files
      ) VALUES (
        ${orderID}, ${userID}, ${patient}, ${details}, ${status}::order_status, ${progress}, ${issue_date}, ${due_date}, ${fileKeys}
      )
    `;

		return new Response(JSON.stringify({ success: true, orderID }), {
			status: 200,
			headers: { "Content-Type": "application/json" },
		});
	} catch (err) {
		return new Response(
			JSON.stringify({ success: false, error: err.message }),
			{ status: 500, headers: { "Content-Type": "application/json" } },
		);
	} finally {
		// Always close DB connection
		DB.end();
	}
}
