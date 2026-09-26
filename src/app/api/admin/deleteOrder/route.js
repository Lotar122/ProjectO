"use server";

import { getUserAuthSession } from "@/app/server-functions/getUserAuthSession";
import { isAdminSession } from "@/app/server-functions/isAdminSession";
import { createS3Client } from "@/app/server-functions/MinIO/createS3Client";
import { deleteOrderFiles } from "@/app/server-functions/orders/orderFiles";
import { cookies } from "next/headers";
import postgres from "postgres";

export async function DELETE(req)
{
	let DB = null;

	try {
		const userAuthSession = await getUserAuthSession(await cookies());

		if (!userAuthSession.loggedIn || !isAdminSession(userAuthSession))
		{
			return Response.json({ error: "Admin access required" }, { status: 403 });
		}

		const orderID = new URL(req.url).searchParams.get("orderID");

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

		const s3 = await createS3Client();
		await deleteOrderFiles(s3, Array.isArray(order.files) ? order.files : []);
		await DB`DELETE FROM orders WHERE order_id = ${orderID}`;

		return Response.json({ success: true });
	} catch (err) {
		return Response.json(
			{ success: false, error: err.message },
			{ status: 500 },
		);
	} finally {
		await DB?.end();
	}
}
