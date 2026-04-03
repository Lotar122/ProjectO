"use server";

import { getUserAuthSession } from "@/app/server-functions/getUserAuthSession";

import { cookies } from "next/headers";

import postgres from "postgres";

import { v7 as uuid7 } from "uuid";

import { writeFile } from "fs/promises";
import { path } from "path";

//Has to be used with credentials
export async function POST(req) {
	try {
		const cookieHeader = await cookies();
		const userAuthSession = await getUserAuthSession(cookieHeader);

		if (!userAuthSession.loggedIn) {
			return new Response(JSON.stringify({ error: "Forbidden" }), {
				status: 403,
				headers: { "Content-Type": "application/json" },
			});
		}

		const userID = userAuthSession.data.identity.id;
		const orderID = formData.get("orderID"); //Get it from request as posting the orders meta return orderID

		const DB = postgres(Bun.env.DB_URL, { prepare: true });

		const formData = await req.formData();

		// 📁 Array of all uploaded files (HTML: name="files")
		const files = formData.getAll("files");

		// Convert File objects → usable JS objects (Buffers)
		const parsedFiles = await Promise.all(
			files.map(async (file) => {
				const arrayBuffer = await file.arrayBuffer();
				return {
					name: file.name,
					type: file.type,
					size: file.size,
					buffer: Buffer.from(arrayBuffer),
				};
			}),
		);

		//Check if the order exists in db and if it belongs to this user. So check both id and user

		//If its valid create a new entry in the files table (create it actually).

		//The files table stores the orderID, fileID, filePath.

		return Response.json(
			{ success: true, orderID: orderID, body },
			{ status: 200 },
		);
	} catch (err) {
		return Response.json(
			{ success: false, error: err.message },
			{ status: 500 },
		);
	}
}
