"use server";

import { getUserAuthSession } from "@/app/server-functions/getUserAuthSession";
import { isAdminSession } from "@/app/server-functions/isAdminSession";
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

export async function PUT(req)
{
	let DB = null;

	try {
		const userAuthSession = await getUserAuthSession(await cookies());

		if (!userAuthSession.loggedIn || !isAdminSession(userAuthSession))
		{
			return Response.json({ error: "Admin access required" }, { status: 403 });
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

		if (!orderID)
		{
			return Response.json({ error: "orderID is required" }, { status: 400 });
		}

		DB = postgres(process.env.DB_URL, { prepare: true, /*ssl: "require"*/ });

		const [order] = await DB`
			SELECT order_id, files
			FROM orders
			WHERE order_id = ${orderID}
			LIMIT 1
		`;

		if (!order)
		{
			return Response.json({ error: "Order not found" }, { status: 404 });
		}

		const currentFileIds = Array.isArray(order.files) ? order.files : [];
		const retainedFileIds = getRetainedFileIds(currentFileIds, existingFileIds);
		const removedFileIds = currentFileIds.filter(
			(fileId) => !retainedFileIds.includes(fileId),
		);
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
			RETURNING *
		`;

		return Response.json({ success: true, order: updatedOrder, uploadedFiles });
	} catch (err) {
		return Response.json(
			{ success: false, error: err.message },
			{ status: 500 },
		);
	} finally {
		await DB?.end();
	}
}
