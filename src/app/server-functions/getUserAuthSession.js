import "server-only";

import axios from "axios";

import { DB } from "@/app/lib/db";
import { KRATOS_TIMEOUT_MS } from "@/app/lib/kratos";
import { createLogger } from "@/app/lib/logger";
import { getIdentityName } from "./getUserName";

const log = createLogger("auth");

const KRATOS_WHOAMI_URL = "http://kratos:4433/sessions/whoami";
const SLOW_KRATOS_MS = 1000;

// Throws when Kratos is unreachable or broken. That must not be reported as
// "logged out": the login page would see a valid session in the browser and
// send the user straight back, looping.
export async function getUserAuthSession(cookie)
{
	const sessionCookie = cookie.get("ory_kratos_session");

	if (!sessionCookie)
	{
		log.debug("No session cookie");

		return {
			loggedIn: false,
			data: null,
		};
	}

	const startedAt = performance.now();
	let res;

	try
	{
		res = await axios.get(KRATOS_WHOAMI_URL, {
			headers: {
				Cookie: `ory_kratos_session=${sessionCookie.value}`,
			},
			timeout: KRATOS_TIMEOUT_MS,
			validateStatus: () => true,
		});
	}
	catch (err)
	{
		const durationMs = Math.round(performance.now() - startedAt);

		log.error(`Kratos whoami failed after ${durationMs}ms: ${err.code || err.message}`);

		throw new Error(`Kratos whoami request failed: ${err.code || err.message}`);
	}

	const durationMs = Math.round(performance.now() - startedAt);

	if (durationMs >= SLOW_KRATOS_MS)
	{
		log.warn(`Kratos whoami slow: ${durationMs}ms (status ${res.status})`);
	}

	if (res.status === 401 || res.status === 403)
	{
		log.info(`Session rejected by Kratos (${res.status})`);

		return {
			loggedIn: false,
			data: res.data,
		};
	}

	if (res.status !== 200)
	{
		log.error(`Kratos whoami returned ${res.status} ${res.statusText}`, res.data);

		throw new Error(`Kratos whoami returned ${res.status}`);
	}

	const identityId = res.data?.identity?.id;

	if (!res.data?.active)
	{
		log.info(`Session for identity ${identityId} is not active`);

		return {
			loggedIn: false,
			data: res.data,
		};
	}

	try
	{
		const users =
			await DB`SELECT 1 FROM users WHERE "user_id" = ${identityId}`;

		if (users.length === 0)
		{
			const name = getIdentityName(res.data.identity);

			await DB`
				INSERT INTO users (
					user_id,
					email,
					name,
					last_name
				)
				VALUES (
					${identityId},
					${res.data.identity.traits?.email},
					${name.first},
					${name.last}
				)
			`;

			log.info(`Created user row for identity ${identityId}`);
		}
	}
	catch (err)
	{
		// The session itself is valid; a failed user-row sync shouldn't log the user out.
		log.error(`Failed to sync user row for identity ${identityId}`, err);
	}

	log.debug(`Authenticated identity ${identityId} (Kratos ${durationMs}ms)`);

	return {
		loggedIn: true,
		data: res.data,
	};
}
