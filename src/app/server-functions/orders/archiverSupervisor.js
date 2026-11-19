// Runs the archiver worker (worker/archiver/main.js) as a supervised Bun child
// process of the web server (ARCHIVER_MODE=embedded). A child, not Bun FFI: a
// compressor OOM or crash only kills the child, and the worker keeps its
// SIGTERM / SIGKILL abort path. The advisory lock in orderArchiver.js keeps
// several web replicas down to one running job.
//
// No "server-only" import: this module is loaded from src/instrumentation-node.js
// (see src/app/lib/logger.js). Uses node:child_process so it runs on Node and Bun.

import { spawn } from "node:child_process";
import path from "node:path";
import { createLogger } from "../../lib/logger.js";

export const DEFAULT_STOP_GRACE_MS = 100_000;
export const DEFAULT_BACKOFF = Object.freeze({
	initialMs: 1_000,
	maxMs: 60_000,
	resetAfterMs: 5 * 60_000,
});

const GLOBAL_KEY = "__projectoArchiverSupervisor";
const WORKER_ENTRY = path.join("worker", "archiver", "main.js");

function readPositiveInt(raw, fallback, name)
{
	if (raw === undefined || raw === "")
	{
		return fallback;
	}

	const value = Number(raw);

	if (!Number.isSafeInteger(value) || value <= 0)
	{
		throw new RangeError(`${name} must be a positive integer, got "${raw}"`);
	}

	return value;
}

/**
 * Creates a supervisor without starting it and without the global guard.
 * Prefer startArchiverSupervisor outside tests.
 *
 * @param {object} [options]
 * @param {Record<string, string | undefined>} [options.env] Source of ARCHIVER_BUN_BIN, ARCHIVER_STOP_GRACE_MS and the child environment (default process.env).
 * @param {{info: Function, warn: Function, error: Function}} [options.log] Logger (default createLogger("archiver-supervisor")).
 * @param {typeof spawn} [options.spawnFn] Replacement for child_process.spawn.
 * @param {string} [options.command] Overrides the runtime command (tests).
 * @param {readonly string[]} [options.args] Overrides the arguments (tests).
 * @param {string} [options.cwd] Base for the worker path (default process.cwd()).
 * @param {number} [options.stopGraceMs] SIGTERM to SIGKILL wait (default ARCHIVER_STOP_GRACE_MS or 100000).
 * @param {{initialMs?: number, maxMs?: number, resetAfterMs?: number}} [options.backoff] Restart delays in ms.
 * @param {boolean} [options.handleSignals] Stop on SIGTERM / SIGINT of this process (default true).
 * @returns {{start: () => void, stop: () => Promise<void>, readonly running: boolean}}
 */
export function createArchiverSupervisor(options = {})
{
	const {
		env = process.env,
		log = createLogger("archiver-supervisor"),
		spawnFn = spawn,
		cwd = process.cwd(),
		handleSignals = true,
	} = options;

	if (typeof spawnFn !== "function")
	{
		throw new TypeError("spawnFn must be a function");
	}

	const stopGraceMs = options.stopGraceMs ?? readPositiveInt(env.ARCHIVER_STOP_GRACE_MS, DEFAULT_STOP_GRACE_MS, "ARCHIVER_STOP_GRACE_MS");
	const backoff = { ...DEFAULT_BACKOFF, ...options.backoff };

	for (const [name, value] of Object.entries({ stopGraceMs, ...backoff }))
	{
		if (!Number.isFinite(value) || value <= 0)
		{
			throw new RangeError(`${name} must be a positive number`);
		}
	}

	const command = options.command ?? (process.versions.bun ? process.execPath : (env.ARCHIVER_BUN_BIN || "bun"));
	const args = options.args ?? ["--conditions", "react-server", path.resolve(cwd, WORKER_ENTRY)];

	let child = null;
	let started = false;
	let stopped = false;
	let stopPromise = null;
	let restartTimer = null;
	let graceTimer = null;
	let resolveStop = null;
	let delayMs = backoff.initialMs;
	let startedAt = 0;
	let signalHandler = null;

	function onChildGone(current, detail)
	{
		if (child !== current)
		{
			return;
		}

		child = null;

		if (stopped)
		{
			log.info(`Archiver worker stopped (${detail})`);
			clearTimeout(graceTimer);
			resolveStop?.();
			return;
		}

		if (Date.now() - startedAt >= backoff.resetAfterMs)
		{
			delayMs = backoff.initialMs;
		}

		log.warn(`Archiver worker exited (${detail}); restarting in ${delayMs} ms`);
		restartTimer = setTimeout(spawnChild, delayMs);
		delayMs = Math.min(delayMs * 2, backoff.maxMs);
	}

	function spawnChild()
	{
		restartTimer = null;

		let current;

		try
		{
			current = spawnFn(command, args, {
				cwd,
				stdio: ["pipe", "inherit", "inherit"],
				env: { ...env, ARCHIVER_SUPERVISED: "1" },
			});
		}
		catch (err)
		{
			// A synchronous spawn failure is retried like a crash.
			log.error(`Archiver worker could not be spawned: ${err.message}`);
			child = null;
			restartTimer = setTimeout(spawnChild, delayMs);
			delayMs = Math.min(delayMs * 2, backoff.maxMs);
			return;
		}

		child = current;
		startedAt = Date.now();
		log.info(`Archiver worker spawned (pid ${current.pid})`);

		// The worker ends when this pipe closes; a write error is not ours to handle.
		current.stdin?.on("error", () => undefined);
		current.once("error", (err) =>
		{
			// 'error' without 'exit' means the process never started (ENOENT).
			log.error(`Archiver worker error: ${err.message}`);
			onChildGone(current, `error ${err.code ?? err.message}`);
		});
		current.once("exit", (code, signal) => onChildGone(current, signal ? `signal ${signal}` : `code ${code}`));
	}

	function start()
	{
		if (started)
		{
			return;
		}

		started = true;

		if (handleSignals)
		{
			signalHandler = () =>
			{
				void stop();
			};
			process.once("SIGTERM", signalHandler);
			process.once("SIGINT", signalHandler);
		}

		spawnChild();
	}

	function stop()
	{
		if (stopPromise)
		{
			return stopPromise;
		}

		stopped = true;

		if (signalHandler)
		{
			process.off("SIGTERM", signalHandler);
			process.off("SIGINT", signalHandler);
		}

		if (restartTimer)
		{
			clearTimeout(restartTimer);
			restartTimer = null;
		}

		const current = child;

		stopPromise = new Promise((resolve) =>
		{
			if (!current)
			{
				resolve();
				return;
			}

			resolveStop = resolve;
			log.info(`Stopping the archiver worker (SIGTERM, then SIGKILL after ${stopGraceMs} ms)`);
			current.kill("SIGTERM");
			graceTimer = setTimeout(() =>
			{
				log.error("Archiver worker did not stop in time; sending SIGKILL");
				current.kill("SIGKILL");
			}, stopGraceMs);
		});

		return stopPromise;
	}

	return {
		start,
		stop,
		get running()
		{
			return child !== null;
		},
	};
}

/**
 * Starts the supervised archiver worker once per process. Safe to call again
 * (Next dev reloads instrumentation): the existing supervisor is returned.
 *
 * @param {object} [options] Same fields as createArchiverSupervisor.
 * @returns {{start: () => void, stop: () => Promise<void>, readonly running: boolean}}
 */
export function startArchiverSupervisor(options = {})
{
	if (globalThis[GLOBAL_KEY])
	{
		return globalThis[GLOBAL_KEY];
	}

	const supervisor = createArchiverSupervisor(options);

	globalThis[GLOBAL_KEY] = supervisor;
	supervisor.start();

	return supervisor;
}

/**
 * Stops the supervisor started by startArchiverSupervisor, if any.
 *
 * @returns {Promise<void>}
 */
export function stop()
{
	return globalThis[GLOBAL_KEY]?.stop() ?? Promise.resolve();
}
