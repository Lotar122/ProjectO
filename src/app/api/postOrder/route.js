"use server";

import { getUserAuthSession } from "@/app/server-functions/getUserAuthSession";
import { createBucket } from "@/app/server-functions/MinIO/createBucket";
import { createS3Client } from "@/app/server-functions/MinIO/createS3Client";
import { PutObjectCommand } from "@aws-sdk/client-s3";
import { cookies } from "next/headers";
import postgres from "postgres";
import { v7 as uuid7 } from "uuid";

// Server POST function for inserting orders
export async function POST(req) {
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

		if (!userAuthSession.loggedIn) {
			return new Response(JSON.stringify({ error: "Forbidden" }), {
				status: 403,
				headers: { "Content-Type": "application/json" },
			});
		}

		const orderID = uuid7();
		const userID = userAuthSession.data.identity.id;

		// Convert dates to ISO strings (YYYY-MM-DD) or null
		const issue_date = issueDate
			? new Date(issueDate).toISOString().split("T")[0]
			: null;
		const due_date = dueDate
			? new Date(dueDate).toISOString().split("T")[0]
			: null;

		const fileBuffers = await Promise.all(
			files.map(async (file) => Buffer.from(await file.arrayBuffer())),
		);

		const s3 = await createS3Client();

		await createBucket(s3, "projecto");

		const fileKeys = await Promise.all(
			fileBuffers.map(async (file, index) => {
				const fileKey = uuid7();

				let fileName;
				const names = patient.split(' ');
				const lowerCaseName = files[index].name.toLowerCase();
				if(lowerCaseName.includes("upper") && lowerCaseName.includes(".stl"))
				{
					fileName = "LowerJawScan.stl";
				}
				else if(lowerCaseName.toLowerCase().includes("lower") && lowerCaseName.includes(".stl"))
				{
					fileName = "UpperJawScan.stl";
				}
				else
				{
					fileName = files[index].name;

					for(let i = 0; i < names.length; i++)
					{
						fileName.replace(names[i], '');
					}
				}

				console.log(fileName);
				console.log(names);

				await s3.send(
					new PutObjectCommand({
						Bucket: "projecto",
						Key: fileKey,
						Body: file,
						Metadata: {
							"original_name": fileName,
						},
					}),
				);

				return fileKey;
			}),
		);

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
