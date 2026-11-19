import "server-only";

import { DB } from "@/app/lib/db";
import { describeDbError } from "@/app/lib/dbError";
import { KRATOS_TIMEOUT_MS } from "@/app/lib/kratos";
import { KRATOS_PUBLIC_INTERNAL_URL } from "@/app/lib/kratosServer";
import { createLogger } from "@/app/lib/logger";
import { getIdentityName } from "./getUserName";

const log = createLogger("auth");

const KRATOS_WHOAMI_URL = `${KRATOS_PUBLIC_INTERNAL_URL}/sessions/whoami`;
const SLOW_KRATOS_MS = 1000;
const UNIQUE_VIOLATION = "23505";
const SESSION_COOKIE_PATTERN = /^[A-Za-z0-9._~+/=-]{1,4096}$/;

// Identities whose users-row sync hit a unique violation; warned once per process.
const warnedUniqueConflicts = new Set();

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

	if (!SESSION_COOKIE_PATTERN.test(sessionCookie.value))
	{
		// A value with CR/LF or non-ByteString characters makes fetch throw, which
		// would be misreported as an unreachable Kratos.
		log.info("Malformed session cookie");

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

	const email = res.data.identity?.traits?.email;

	if (typeof email === "string" && email)
	{
		await syncUserRow(identityId, email, getIdentityName(res.data.identity));
	}
	else
	{
		// Nothing to write, and an undefined parameter makes every query throw.
		log.debug(`Identity ${identityId} has no email trait; users row not synced`);
	}

	log.debug(`Authenticated identity ${identityId} (Kratos ${durationMs}ms)`);

	return {
		loggedIn: true,
		data: res.data,
	};
}

// The session itself is valid; a failed user-row sync must never log the user out.
async function syncUserRow(identityId, email, name)
{
	try
	{
		// One round trip, and no row lock on the hot path (every authenticated
		// request). A plain INSERT .. ON CONFLICT DO UPDATE .. WHERE <false> still
		// locks the conflicting row, so the two cases are separate CTEs that see
		// the same snapshot:
		//   upd: only touches a row whose values differ, so an unchanged row is
		//        read and never locked or written.
		//   ins: only inserts when no row is visible; a concurrent insert of the
		//        same user falls into DO NOTHING.
		// Nothing is returned when nothing changed.
		const synced = await DB`
			WITH upd AS (
				UPDATE users
				SET
					email = ${email},
					name = ${name.first},
					last_name = ${name.last}
				WHERE user_id = ${identityId}
					AND (email, name, last_name)
						IS DISTINCT FROM (${email}, ${name.first}, ${name.last})
				RETURNING user_id, false AS inserted
			),
			ins AS (
				INSERT INTO users (user_id, email, name, last_name)
				SELECT ${identityId}, ${email}, ${name.first}, ${name.last}
				WHERE NOT EXISTS (SELECT 1 FROM users WHERE user_id = ${identityId})
				ON CONFLICT (user_id) DO NOTHING
				RETURNING user_id, true AS inserted
			)
			SELECT user_id, inserted FROM upd
			UNION ALL
			SELECT user_id, inserted FROM ins
		`;

		if (synced.length > 0)
		{
			log.info(`${synced[0].inserted ? "Created" : "Updated"} user row for identity ${identityId}`);
		}
	}
	catch (err)
	{
		if (err?.code === UNIQUE_VIOLATION)
		{
			// Most likely another users row already holds this email. It repeats on
			// every request, so say it once per identity.
			if (!warnedUniqueConflicts.has(identityId))
			{
				warnedUniqueConflicts.add(identityId);
				log.warn(`User row for identity ${identityId} not synced: ${describeDbError(err)}`);
			}
		}
		else
		{
			log.error(`Failed to sync user row for identity ${identityId}: ${describeDbError(err)}`);
		}
	}
}
