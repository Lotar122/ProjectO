import "server-only";

import { createLogger } from "./logger";

const log = createLogger("http");

const SLOW_REQUEST_MS = 2000;
// Uploads of large scans can legitimately take minutes; this only exists so a
// wedged handler shows up in the log instead of silently holding a request.
const STUCK_REQUEST_MS = 120000;
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

const getAllowedOrigins = () =>
	String(process.env.ALLOWED_ORIGINS || "")
		.split(",")
		.map((origin) => origin.trim())
		.filter(Boolean);

// CSRF guard for cookie-authenticated, state-changing routes. Browsers always
// send Sec-Fetch-Site (and Origin on cross-origin writes); non-browser clients
// send neither and cannot be driven by a victim's cookies.
function isCrossSiteWrite(req)
{
	if (SAFE_METHODS.has(req.method))
	{
		return false;
	}

	const fetchSite = req.headers.get("sec-fetch-site");

	if (fetchSite)
	{
		return fetchSite !== "same-origin" && fetchSite !== "none";
	}

	const origin = req.headers.get("origin");

	if (!origin)
	{
		return false;
	}

	if (getAllowedOrigins().includes(origin))
	{
		return false;
	}

	const host = req.headers.get("x-forwarded-host") || req.headers.get("host");

	try
	{
		return new URL(origin).host !== host;
	}
	catch
	{
		return true;
	}
}

// Wraps a route handler with one access-log line per request:
// method, path, status and duration. Query strings are left out because they
// can contain patient search terms.
export function withRequestLogging(handler)
{
	return async function loggedHandler(req, context)
	{
		const startedAt = performance.now();
		const target = `${req.method} ${new URL(req.url).pathname}`;

		if (isCrossSiteWrite(req))
		{
			log.warn(`${target} 403 (cross-site write blocked)`);

			return Response.json({ error: "Forbidden" }, { status: 403 });
		}

		const stuckTimer = setTimeout(() =>
		{
			log.warn(`${target} still running after ${STUCK_REQUEST_MS}ms`);
		}, STUCK_REQUEST_MS);

		try
		{
			const response = await handler(req, context);
			const durationMs = Math.round(performance.now() - startedAt);
			const line = `${target} ${response.status} ${durationMs}ms`;

			if (response.status >= 500)
			{
				log.error(line);
			}
			else if (durationMs >= SLOW_REQUEST_MS)
			{
				log.warn(`${line} (slow)`);
			}
			else
			{
				log.info(line);
			}

			return response;
		}
		catch (err)
		{
			const durationMs = Math.round(performance.now() - startedAt);

			log.error(`${target} threw after ${durationMs}ms`, err);

			throw err;
		}
		finally
		{
			clearTimeout(stuckTimer);
		}
	};
}
