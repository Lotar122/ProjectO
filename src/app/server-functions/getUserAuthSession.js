"use server";

import axios from "axios";
import postgres from "postgres";

import { getNameFromEmail } from "./getUserName";

export async function getUserAuthSession(cookie) {
	const cookieHeader = cookie.get("ory_kratos_session");
	let res = null;
	let loggedIn = false;
	try {
		res = await axios.get(`https://localhost:4433/sessions/whoami`, {
			headers: {
				cookie: `${cookieHeader.name}=${cookieHeader.value}`,
			},
			withCredentials: false,
		});

		if (res.data && res.data.active) {
			const DB = postgres(process.env.DB_URL, { prepare: true });

			let users = null;
			try {
				users =
					await DB`SELECT * FROM users WHERE "user_id" = ${res.data.identity.id}`;
			} catch (err) {
				console.error(err);
			}

			if (users.length == 0) {
				const name = await getNameFromEmail(
					res.data.identity.traits.email,
				);
				try {
					await DB`
			INSERT INTO users (user_id, email, name, last_name)
			VALUES (${res.data.identity.id}, ${res.data.identity.traits.email}, ${name.first}, ${name.last})
			`;
				} catch (err) {
					console.error(err);
				}
			}

			await DB.end();

			loggedIn = true;
		}
	} catch (err) {
		loggedIn = false;
		throw err;
	}

	let result = {
		loggedIn: loggedIn,
		data: res?.data,
	};

	return result;
}
