// Shutdown timing and ordering for the archiver worker entry (main.js).

import { DEFAULT_STOP_GRACE_MS } from "@/app/server-functions/orders/archiverSupervisor";

// setTimeout clamps anything above this to 1 ms.
const TIMER_MS_MAX = 2 ** 31 - 1;
// Time left between the worker's own deadline and the SIGKILL, for the exit
// itself: at most 10 s, and a tenth of a short grace.
const STOP_MARGIN_MS_MAX = 10_000;

/**
 * The longest a graceful stop may take before the worker exits 1 on its own.
 * Strictly shorter than ARCHIVER_STOP_GRACE_MS, the supervisor's SIGTERM to
 * SIGKILL wait (archiverSupervisor.js, default 100 s), so the worker exits
 * (closing its lock connection and the compressor's stdin pipe) before it is
 * SIGKILLed: the grace minus min(10 s, a tenth of the grace, rounded up).
 * The default grace gives 90 s, which also fits the standalone container's
 * 2 min stop_grace_period. A grace of 1 ms gives 0: exit at once.
 *
 * @param {Record<string, string | undefined>} [env] Source of ARCHIVER_STOP_GRACE_MS (default process.env).
 * @returns {number} milliseconds, from 0 to 2147483647
 * @throws {RangeError} when ARCHIVER_STOP_GRACE_MS is set but not a positive integer
 */
export function readStopDeadlineMs(env = process.env)
{
	const raw = env.ARCHIVER_STOP_GRACE_MS;
	let graceMs = DEFAULT_STOP_GRACE_MS;

	// Parsed like the supervisor does, so both sides agree on the value.
	if (raw !== undefined && raw !== "")
	{
		graceMs = Number(raw);

		if (!Number.isSafeInteger(graceMs) || graceMs <= 0)
		{
			throw new RangeError(`ARCHIVER_STOP_GRACE_MS must be a positive integer, got "${raw}"`);
		}
	}

	const marginMs = Math.min(STOP_MARGIN_MS_MAX, Math.ceil(graceMs / 10));

	return Math.min(graceMs - marginMs, TIMER_MS_MAX);
}

/**
 * Runs the worker until it stops, then waits for the rest of its stop (the
 * in-flight heartbeat and removing its archive_workers row) before closing
 * the database pool. run() resolves as soon as the poll loop ends, which is
 * before stop() has deregistered the worker.
 *
 * @param {{ run: () => Promise<void>, stop: () => Promise<void> }} worker from createArchiveWorker
 * @param {{ end: (options: { timeout: number }) => Promise<unknown> }} sql the pool to close afterwards
 * @returns {Promise<void>}
 */
export async function runUntilStopped(worker, sql)
{
	if (typeof worker?.run !== "function" || typeof worker.stop !== "function")
	{
		throw new TypeError("worker must have run() and stop()");
	}

	if (typeof sql?.end !== "function")
	{
		throw new TypeError("sql must have end()");
	}

	await worker.run();
	// stop() is idempotent: this joins the stop a signal started.
	await worker.stop();
	await sql.end({ timeout: 5 });
}
