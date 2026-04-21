"use server";

import { getUserAuthSession } from "@/app/server-functions/getUserAuthSession";
import { createS3Client } from "@/app/server-functions/MinIO/createS3Client";
import { deleteFileFromMinio } from "@/app/server-functions/MinIO/deleteFile";

import { cookies } from "next/headers";

import postgres from "postgres";

//Has to be used with credentials
export async function DELETE(req) {
	let DB = null;

	try {
		const cookieHeader = await cookies();
		const userAuthSession = await getUserAuthSession(cookieHeader);

		if (!userAuthSession.loggedIn) {
			return new Response(JSON.stringify({ error: "Forbidden" }), {
				status: 403,
				headers: { "Content-Type": "application/json" },
			});
		}

		const url = new URL(req.url);
		const orderID = url.searchParams.get("orderID");

		if (!orderID) {
			return new Response(JSON.stringify({ error: "orderID is required" }), {
				status: 400,
				headers: { "Content-Type": "application/json" },
			});
		}

		DB = postgres(process.env.DB_URL, { prepare: true, ssl: "require" });

		const [order] = await DB`
			SELECT order_id, files
			FROM orders
			WHERE order_id = ${orderID}
				AND user_id = ${userAuthSession.data.identity.id}
			LIMIT 1
		`;

		if (!order) {
			return new Response(JSON.stringify({ error: "Order not found" }), {
				status: 404,
				headers: { "Content-Type": "application/json" },
			});
		}

		const s3 = await createS3Client();
		await Promise.all(
			order.files.map((file) => deleteFileFromMinio(s3, "projecto", file)),
		);
		await DB`
			DELETE FROM orders
			WHERE order_id = ${orderID}
				AND user_id = ${userAuthSession.data.identity.id}
		`;

		return Response.json({ success: true }, { status: 200 });
	} catch (err) {
		return Response.json(
			{ success: false, error: err.message },
			{ status: 500 },
		);
	} finally {
		await DB?.end();
	}
}
