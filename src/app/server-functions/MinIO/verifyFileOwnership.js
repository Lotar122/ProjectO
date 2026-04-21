"use server";

import { cookies } from "next/headers";
import postgres from "postgres";

import { getUserAuthSession } from "@/app/server-functions/getUserAuthSession";

export async function verifyFileOwnership(fileId) {
	const cookieStore = await cookies();
	const userAuthSession = await getUserAuthSession(cookieStore);

	if (!userAuthSession.loggedIn) {
		throw new Error("Forbidden");
	}

	const userId = userAuthSession.data.identity.id;
	const DB = postgres(process.env.DB_URL, { prepare: true, ssl: "require" });

	try {
		const [ownedFile] = await DB`
			SELECT 1
			FROM orders
			WHERE user_id = ${userId}
				AND ${fileId} = ANY(files)
			LIMIT 1
		`;

		if (!ownedFile) {
			throw new Error("You do not have permission to access this file");
		}
	} finally {
		await DB.end();
	}
}
