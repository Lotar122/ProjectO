import "server-only";

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
		const response = await fetch(KRATOS_WHOAMI_URL, {
			headers: {
				Cookie: `ory_kratos_session=${sessionCookie.value}`,
				Accept: "application/json",
			},
			cache: "no-store",
			signal: AbortSignal.timeout(KRATOS_TIMEOUT_MS),
		});
		const body = await response.text();
		let data = null;

		try
		{
			data = body ? JSON.parse(body) : null;
		}
		catch
		{
			// Non-JSON error page; keep the raw text for logging.
			data = body;
		}

		res = {
			status: response.status,
			statusText: response.statusText,
			data,
		};
	}
	catch (err)
	{
		const durationMs = Math.round(performance.now() - startedAt);
		const reason = err.name === "TimeoutError"
			? `timed out after ${KRATOS_TIMEOUT_MS}ms`
			: err.cause?.code || err.message;

		log.error(`Kratos whoami failed after ${durationMs}ms: ${reason}`);

		throw new Error(`Kratos whoami request failed: ${reason}`);
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
		const name = getIdentityName(res.data.identity);

		// One round trip; the row only changes for identities seen for the first time.
		const created = await DB`
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
			ON CONFLICT (user_id) DO NOTHING
			RETURNING user_id
		`;

		if (created.length > 0)
		{
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
