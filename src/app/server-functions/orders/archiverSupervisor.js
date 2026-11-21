// Runs the archiver worker (worker/archiver/main.js) as a supervised Bun child
// process of the web server (ARCHIVER_MODE=embedded). A child, not Bun FFI: a
// compressor OOM or crash only kills the child, and the worker keeps its
// SIGTERM / SIGKILL abort path. The advisory lock in orderArchiver.js keeps
// several web replicas down to one running job.
//
// On POSIX the worker leads its own process group, so the SIGKILL escalation
// and the clean-up after a crash also reach the projecto-compress child it may
// have left behind.
//
// Shutdown: `next start` exits on SIGTERM / SIGINT without waiting for stop().
// With NEXT_MANUAL_SIG_HANDLE set (docker/web-supervised.Dockerfile) Next
// registers no handler, and the supervisor exits the process itself once the
// worker has stopped.
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
// After SIGKILL the exit event should follow at once; stop() resolves after
// this long even if it never comes, so shutdown cannot hang.
const KILL_WAIT_MS = 5_000;
// 128 + signal number, as `next start` uses.
const SIGNAL_EXIT_CODES = Object.freeze({ SIGINT: 130, SIGTERM: 143 });

const isPid = (pid) => Number.isSafeInteger(pid) && pid > 0;

// Signals every process in the group the worker leads. False when there is no
// such group (ESRCH, the normal case once all of it has exited).
function signalGroup(pid, signal)
{
	try
	{
		process.kill(-pid, signal);
		return true;
	}
	catch
	{
		return false;
	}
}

// Sends signal to the worker's process group when it leads one, else to the
// worker alone. Never throws.
function signalWorker(child, signal, useGroup)
{
	if (useGroup && isPid(child.pid) && signalGroup(child.pid, signal))
	{
		return;
	}

	try
	{
		child.kill(signal);
	}
	catch
	{
		// A kill failure is reported through the child's "error" event.
	}
}

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
 * @param {boolean} [options.exitOnSignal] After a signal-triggered stop, exit the process with
 *   128 + the signal number (default: true when env.NEXT_MANUAL_SIG_HANDLE is set, because then
 *   nothing else exits). Only used with handleSignals.
 * @param {(code: number) => void} [options.exitFn] Replacement for process.exit (tests).
 * @param {boolean} [options.processGroup] Run the worker as a process group leader and signal the
 *   whole group on SIGKILL and after a crash (default true, except on Windows).
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
		exitOnSignal = Boolean(env.NEXT_MANUAL_SIG_HANDLE),
		exitFn = (code) => process.exit(code),
		processGroup = process.platform !== "win32",
	} = options;

	if (typeof spawnFn !== "function")
	{
		throw new TypeError("spawnFn must be a function");
	}

	if (typeof exitFn !== "function")
	{
		throw new TypeError("exitFn must be a function");
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
	let killWaitTimer = null;
	let resolveStop = null;
	let delayMs = backoff.initialMs;
	let startedAt = 0;
	let signalHandler = null;

	function finishStop()
	{
		clearTimeout(graceTimer);
		clearTimeout(killWaitTimer);
		graceTimer = null;
		killWaitTimer = null;
		resolveStop?.();
		resolveStop = null;
	}

	function onChildGone(current, detail)
	{
		if (child !== current)
		{
			return;
		}

		child = null;

		// The worker is gone; a compressor it started may not be. Its process
		// group still exists only if something in it is still running.
		if (processGroup && isPid(current.pid))
		{
			signalGroup(current.pid, "SIGKILL");
		}

		if (stopped)
		{
			log.info(`Archiver worker stopped (${detail})`);
			finishStop();
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
				// POSIX: a new process group led by the worker (see signalWorker).
				detached: processGroup,
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
		// "error" can fire more than once (a failed kill() also lands here), and
		// an unhandled one would throw, so the listener stays.
		current.on("error", (err) =>
		{
			log.error(`Archiver worker error: ${err.message}`);

			// Only a child that never started (ENOENT, EACCES) has no pid and no
			// "exit" to wait for. Any other error, such as a failed kill(),
			// leaves the worker running, and "exit" reports its end.
			if (current.pid === undefined)
			{
				onChildGone(current, `error ${err.code ?? err.message}`);
			}
		});
		current.once("exit", (code, signal) => onChildGone(current, signal ? `signal ${signal}` : `code ${code}`));
	}

	function onSignal(signal)
	{
		if (!exitOnSignal)
		{
			void stop();
			return;
		}

		log.info(`Received ${signal}; exiting once the archiver worker has stopped`);
		void stop().then(() => exitFn(SIGNAL_EXIT_CODES[signal] ?? 128));
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
			// "on", not "once": with exitOnSignal nothing else handles a repeated
			// signal, and its default action would kill the process mid-stop.
			signalHandler = onSignal;
			process.on("SIGTERM", signalHandler);
			process.on("SIGINT", signalHandler);
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

		// With exitOnSignal the handler stays: it is this process's only exit
		// path on SIGTERM / SIGINT, also after a stop() that came from elsewhere.
		if (signalHandler && !exitOnSignal)
		{
			process.off("SIGTERM", signalHandler);
			process.off("SIGINT", signalHandler);
			signalHandler = null;
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
			// The worker alone: it aborts its compressor and ends the job itself.
			signalWorker(current, "SIGTERM", false);
			graceTimer = setTimeout(() =>
			{
				log.error("Archiver worker did not stop in time; sending SIGKILL to its process group");
				signalWorker(current, "SIGKILL", processGroup);
				killWaitTimer = setTimeout(() =>
				{
					log.error(`Archiver worker did not exit ${KILL_WAIT_MS} ms after SIGKILL; giving up on it`);
					finishStop();
				}, KILL_WAIT_MS);
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
