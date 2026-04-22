"use server";

import { getUserAuthSession } from "@/app/server-functions/getUserAuthSession";
import { createBucket } from "@/app/server-functions/MinIO/createBucket";
import { createS3Client } from "@/app/server-functions/MinIO/createS3Client";
import { PutObjectCommand } from "@aws-sdk/client-s3";
import { cookies } from "next/headers";
import postgres from "postgres";
import { v7 as uuid7 } from "uuid";

function escapeRegExp(value) {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function sanitizeFileName(patient, originalFileName) {
	const extensionIndex = originalFileName.lastIndexOf(".");
	const hasExtension = extensionIndex !== -1;
	const extension = hasExtension ? originalFileName.slice(extensionIndex) : "";
	let baseName = hasExtension
		? originalFileName.slice(0, extensionIndex)
		: originalFileName;

	const patientParts = patient
		.split(/\s+/)
		.map((part) => part.trim())
		.filter(Boolean)
		.sort((a, b) => b.length - a.length);

	for (const part of patientParts) {
		const escapedPart = escapeRegExp(part);
		baseName = baseName.replace(
			new RegExp(`(^|[\\s_-])${escapedPart}(?=$|[\\s_-])`, "gi"),
			"$1",
		);
	}

	baseName = baseName
		.replace(/[\s_-]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();

	const normalizedBaseName = baseName.toLowerCase();
	const normalizedExtension = extension.toLowerCase();

	if (normalizedExtension === ".stl") {
		if (/\bupper\b/.test(normalizedBaseName)) {
			return "UpperJawScan.stl";
		}

		if (/\blower\b/.test(normalizedBaseName)) {
			return "LowerJawScan.stl";
		}

		console.log(baseName ? `${baseName}${extension}` : `file${extension}`);
	}

	return baseName ? `${baseName}${extension}` : `file${extension}`;
}

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
				const fileName = sanitizeFileName(patient, files[index].name);

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

				console.log(fileName);

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
