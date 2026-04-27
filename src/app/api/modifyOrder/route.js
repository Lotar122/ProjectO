"use server";

import { getUserAuthSession } from "@/app/server-functions/getUserAuthSession";
import { createBucket } from "@/app/server-functions/MinIO/createBucket";
import { createS3Client } from "@/app/server-functions/MinIO/createS3Client";
import { DeleteObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
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

	const patientParts = String(patient || "")
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
		if (/upper/.test(normalizedBaseName)) {
			return "UpperJawScan.stl";
		}

		if (/lower/.test(normalizedBaseName)) {
			return "LowerJawScan.stl";
		}
	}

	return baseName ? `${baseName}${extension}` : `file${extension}`;
}

export async function PUT(req) {
	const DB = postgres(process.env.DB_URL, { prepare: true, ssl: "require" });

	try {
		const cookieHeader = await cookies();
		const userAuthSession = await getUserAuthSession(cookieHeader);

		if (!userAuthSession.loggedIn) {
			return new Response(JSON.stringify({ error: "Forbidden" }), {
				status: 403,
				headers: { "Content-Type": "application/json" },
			});
		}

		const formData = await req.formData();
		const orderID = formData.get("orderID");
		const patient = formData.get("patient");
		const details = formData.get("details");
		const dueDate = formData.get("dueDate");
		const existingFileIds = formData
			.getAll("existingFileIds")
			.map((fileId) => String(fileId))
			.filter(Boolean);
		const newFiles = formData.getAll("files");
		const userID = userAuthSession.data.identity.id;

		if (!orderID) {
			return new Response(JSON.stringify({ error: "orderID is required" }), {
				status: 400,
				headers: { "Content-Type": "application/json" },
			});
		}

		const [order] = await DB`
			SELECT order_id, files, status, progress, issue_date
			FROM orders
			WHERE order_id = ${orderID}
				AND user_id = ${userID}
			LIMIT 1
		`;

		if (!order) {
			return new Response(JSON.stringify({ error: "Order not found" }), {
				status: 404,
				headers: { "Content-Type": "application/json" },
			});
		}

		const currentFileIds = Array.isArray(order.files) ? order.files : [];
		const retainedFileIds = currentFileIds.filter((fileId) =>
			existingFileIds.includes(fileId),
		);
		const removedFileIds = currentFileIds.filter(
			(fileId) => !retainedFileIds.includes(fileId),
		);

		const s3 = await createS3Client();
		await createBucket(s3, "projecto");

		const uploadedFiles = await Promise.all(
			newFiles.map(async (file) => {
				const fileID = uuid7();
				const fileBuffer = Buffer.from(await file.arrayBuffer());
				const fileName = sanitizeFileName(patient, file.name);

				await s3.send(
					new PutObjectCommand({
						Bucket: "projecto",
						Key: fileID,
						Body: fileBuffer,
						Metadata: {
							original_name: fileName,
						},
					}),
				);

				return { fileID, fileName };
			}),
		);

		if (removedFileIds.length > 0) {
			await Promise.all(
				removedFileIds.map((fileId) =>
					s3.send(
						new DeleteObjectCommand({
							Bucket: "projecto",
							Key: fileId,
						}),
					),
				),
			);
		}

		const nextFileIds = [
			...retainedFileIds,
			...uploadedFiles.map((file) => file.fileID),
		];
		const due_date = dueDate
			? new Date(dueDate).toISOString().split("T")[0]
			: null;

		const [updatedOrder] = await DB`
			UPDATE orders
			SET patient = ${patient},
				details = ${details},
				due_date = ${due_date},
				files = ${nextFileIds}
			WHERE order_id = ${orderID}
				AND user_id = ${userID}
			RETURNING *
		`;

		return new Response(
			JSON.stringify({
				success: true,
				order: updatedOrder,
				uploadedFiles,
			}),
			{
				status: 200,
				headers: { "Content-Type": "application/json" },
			},
		);
	} catch (err) {
		return new Response(
			JSON.stringify({ success: false, error: err.message }),
			{ status: 500, headers: { "Content-Type": "application/json" } },
		);
	} finally {
		await DB.end();
	}
}
