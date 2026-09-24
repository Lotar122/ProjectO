"use server";

import axios from "axios";
import postgres from "postgres";

import { getNameFromEmail } from "./getUserName";

export async function getUserAuthSession(cookie)
{
	console.log("[AUTH] getUserAuthSession() called");

	const sessionCookie = cookie.get("ory_kratos_session");

	console.log("[AUTH] Session cookie present:", !!sessionCookie);

	if (!sessionCookie)
	{
		console.log("[AUTH] No ory_kratos_session cookie");

		return {
			loggedIn: false,
			data: null,
		};
	}

	const kratosUrl =
		"http://host.docker.internal:4433/sessions/whoami";

	console.log("[AUTH] Requesting Kratos:", kratosUrl);

	try
	{
		const res = await axios.get(kratosUrl, {
			headers: {
				Cookie: `ory_kratos_session=${sessionCookie.value}`,
			},
			validateStatus: () => true,
		});

		console.log("[AUTH] Kratos status:", res.status);
		console.log("[AUTH] Kratos response:", res.data);

		if (res.status !== 200)
		{
			console.error(
				"[AUTH] Kratos whoami returned non-200:",
				{
					status: res.status,
					statusText: res.statusText,
					data: res.data,
				},
			);

			return {
				loggedIn: false,
				data: res.data,
			};
		}

		if (!res.data?.active)
		{
			console.log("[AUTH] Kratos session is not active");

			return {
				loggedIn: false,
				data: res.data,
			};
		}

		const identityId = res.data.identity?.id;
		const email = res.data.identity?.traits?.email;

		console.log("[AUTH] Authenticated identity:", {
			identityId,
			email,
		});

		const DB = postgres(process.env.DB_URL, {
			prepare: true,
			ssl: "require",
		});

		try
		{
			console.log("[AUTH] Looking up user in database");

			const users =
				await DB`SELECT * FROM users WHERE "user_id" = ${identityId}`;

			console.log("[AUTH] Database users found:", users.length);

			if (users.length === 0)
			{
				console.log("[AUTH] User does not exist, getting name");

				const name = await getNameFromEmail(email);

				console.log("[AUTH] Name from Kratos:", name);

				try
				{
					await DB`
						INSERT INTO users (
							user_id,
							email,
							name,
							last_name
						)
						VALUES (
							${identityId},
							${email},
							${name.first},
							${name.last}
						)
					`;

					console.log("[AUTH] User inserted successfully");
				}
				catch (err)
				{
					console.error("[AUTH] Failed to insert user:", err);
				}
			}
		}
		catch (err)
		{
			console.error("[AUTH] Database query failed:", err);
		}
		finally
		{
			await DB.end();
			console.log("[AUTH] Database connection closed");
		}

		console.log("[AUTH] Authentication successful");

		return {
			loggedIn: true,
			data: res.data,
		};
	}
	catch (err)
	{
		console.error("[AUTH] Unexpected authentication error:", err);

		if (axios.isAxiosError(err))
		{
			console.error("[AUTH] Axios error:", {
				message: err.message,
				code: err.code,
				status: err.response?.status,
				statusText: err.response?.statusText,
				data: err.response?.data,
				url: err.config?.url,
				method: err.config?.method,
			});
		}

		return {
			loggedIn: false,
			data: null,
		};
	}
}