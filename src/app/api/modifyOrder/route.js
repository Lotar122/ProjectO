"use server";

import { getUserAuthSession } from "@/app/server-functions/getUserAuthSession";
import { createS3Client } from "@/app/server-functions/MinIO/createS3Client";
import {
	deleteOrderFiles,
	ensureOrderFilesBucket,
	toISODate,
	uploadOrderFiles,
} from "@/app/server-functions/orders/orderFiles";
import { cookies } from "next/headers";
import postgres from "postgres";

function getRetainedFileIds(currentFileIds, requestedFileIds)
{
	return currentFileIds.filter((fileId) => requestedFileIds.includes(fileId));
}

function getRemovedFileIds(currentFileIds, retainedFileIds)
{
	return currentFileIds.filter((fileId) => !retainedFileIds.includes(fileId));
}

export async function PUT(req)
{
	const DB = postgres(process.env.DB_URL, { prepare: true, ssl: "require" });

	try {
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

		if (!orderID)
		{
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

		if (!order)
		{
			return new Response(JSON.stringify({ error: "Order not found" }), {
				status: 404,
				headers: { "Content-Type": "application/json" },
			});
		}

		const currentFileIds = Array.isArray(order.files) ? order.files : [];
		const retainedFileIds = getRetainedFileIds(currentFileIds, existingFileIds);
		const removedFileIds = getRemovedFileIds(currentFileIds, retainedFileIds);
		const due_date = toISODate(dueDate);

		const s3 = await createS3Client();
		await ensureOrderFilesBucket(s3);

		const uploadedFiles = await uploadOrderFiles(s3, newFiles, patient);
		await deleteOrderFiles(s3, removedFileIds);

		const nextFileIds = [
			...retainedFileIds,
			...uploadedFiles.map((file) => file.fileID),
		];

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
