import "server-only";

import { createLogger } from "./logger";

const log = createLogger("http");

const SLOW_REQUEST_MS = 2000;

// Wraps a route handler with one access-log line per request:
// method, path, status and duration. Query strings are left out because they
// can contain patient search terms.
export function withRequestLogging(handler)
{
	return async function loggedHandler(req, context)
	{
		const startedAt = performance.now();
		const target = `${req.method} ${new URL(req.url).pathname}`;

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
	};
}
