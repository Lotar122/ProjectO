import { setTimeout as sleep } from "node:timers/promises";

import { createLogger } from "@/app/lib/logger";
import {
	INTERRUPTED_ERROR,
	claimQueuedJob,
	deleteStaleWorkers,
	finishJob,
	hasQueuedJob,
	heartbeatWorker,
	markStaleJobsInterrupted,
	writeJobProgress,
} from "@/app/server-functions/orders/archiveJobs";
import {
	DB_TIMEOUT_MS,
	acquireArchiveLock,
	createStatus,
	recoverPendingVerifications,
	releaseArchiveLock,
	runArchiveJob,
	sweepTempDir,
	withTimeout,
} from "@/app/server-functions/orders/orderArchiver";

import { createProgressFlusher } from "./progressFlusher.js";

// The archiver worker's runtime (phases-bugfix/phase4.md 5.2 and 9.6): startup
// cleanup under the advisory lock, a poll loop that claims queued jobs under
// the lock, progress and heartbeat timers, and a graceful stop. main.js wires
// it to the real database, S3 client and compressor.

export const POLL_MS = 5_000;
export const FLUSH_MS = 2_000;
export const HEARTBEAT_MS = 10_000;
// Tries to store a job's final state before giving up and releasing the lock.
const FINISH_ATTEMPTS = 3;

// Crash recovery (phases-bugfix/phase4.md 9.3, 9.4). Both run while this
// worker holds the archive lock, with the shared pool (never the lock client).
// - Startup, after the stale jobs are marked: settle the journal, then sweep
//   the temp directory (the sweep keeps every original a row still references).
// - Job start, before the candidate loop, so no order is marked while one of
//   its files still has a journal row. A failure here fails the job.
async function recoverAtStartup({ sql, s3, timeoutMs, shouldStop })
{
	await recoverPendingVerifications(sql, s3, { timeoutMs, shouldStop });
	await sweepTempDir({ sql, timeoutMs });
}

async function recoverAtJobStart({ sql, s3, timeoutMs, shouldStop })
{
	await recoverPendingVerifications(sql, s3, { timeoutMs, shouldStop });
}

// A progress write was skipped because an earlier one has not settled yet.
class ProgressWriteBusyError extends Error
{
	constructor()
	{
		super("The previous progress write has not settled yet");
		this.name = "ProgressWriteBusyError";
	}
}

function toIso(value)
{
	const date = value instanceof Date ? value : new Date(value ?? Date.now());

	return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
}

function assertInterval(value, name)
{
	if (!Number.isSafeInteger(value) || value < 1)
	{
		throw new RangeError(`${name} must be a positive integer`);
	}
}

/**
 * @typedef {object} ArchiveWorker
 * @property {() => Promise<void>} run Runs startup and the poll loop until stop(); resolves once stopped.
 * @property {() => Promise<void>} tick One poll iteration (finishes startup first if it is still pending). Never throws.
 * @property {() => Promise<void>} stop Graceful stop (9.6); resolves once run() has returned.
 * @property {() => boolean} isStartupDone
 */

/**
 * @param {object} options
 * @param {Function} options.sql postgres.js pool for the job queries.
 * @param {() => Function & { end: Function }} [options.openLockClient] Creates the
 *   dedicated one-connection client the advisory lock lives on; tests pass a fake.
 * @param {object} options.s3 S3 client.
 * @param {string} options.workerId Row key in archive_workers.
 * @param {string} options.version Image tag / git sha and compressor version.
 * @param {(srcPath: string, options: object) => Promise<object | null>} options.compress
 *   nativeCompressBest-shaped; the worker adds `signal`, aborted on stop().
 * @param {number} [options.pollMs]
 * @param {number} [options.flushMs]
 * @param {number} [options.heartbeatMs]
 * @param {number} [options.dbTimeoutMs] Bound for every database statement.
 * @param {{ info: Function, warn: Function, error: Function }} [options.log]
 * @param {(context: { sql: Function, s3: object, timeoutMs: number, shouldStop: () => boolean }) => Promise<void>} [options.recoverAtStartup]
 *   Crash recovery and temp sweep at startup; tests pass a fake.
 * @param {(context: { sql: Function, s3: object, jobId: string | number, timeoutMs: number, shouldStop: () => boolean }) => Promise<void>} [options.recoverAtJobStart]
 *   Crash recovery before each job's candidate loop; tests pass a fake.
 * @returns {ArchiveWorker}
 */
export function createArchiveWorker({
	sql,
	s3,
	workerId,
	version,
	compress,
	pollMs = POLL_MS,
	flushMs = FLUSH_MS,
	heartbeatMs = HEARTBEAT_MS,
	dbTimeoutMs = DB_TIMEOUT_MS,
	openLockClient,
	log = createLogger("archiver-worker"),
	recoverAtStartup: startupRecovery = recoverAtStartup,
	recoverAtJobStart: jobStartRecovery = recoverAtJobStart,
})
{
	if (typeof sql !== "function")
	{
		throw new TypeError("sql must be a postgres.js client");
	}

	if (openLockClient !== undefined && typeof openLockClient !== "function")
	{
		throw new TypeError("openLockClient must be a function");
	}

	if (!s3 || typeof s3.send !== "function")
	{
		throw new TypeError("s3 must be an S3 client");
	}

	for (const [name, value] of [["workerId", workerId], ["version", version]])
	{
		if (typeof value !== "string" || value === "")
		{
			throw new TypeError(`${name} must be a non-empty string`);
		}
	}

	if (typeof compress !== "function")
	{
		throw new TypeError("compress must be a function");
	}

	assertInterval(pollMs, "pollMs");
	assertInterval(flushMs, "flushMs");
	assertInterval(heartbeatMs, "heartbeatMs");
	assertInterval(dbTimeoutMs, "dbTimeoutMs");

	const bounded = (promise, label) => withTimeout(promise, label, dbTimeoutMs);
	const takeLock = () => acquireArchiveLock({ timeoutMs: dbTimeoutMs, ...(openLockClient ? { openClient: openLockClient } : {}) });
	const stopController = new AbortController();
	let stopping = false;
	let registered = false;
	let startupDone = false;
	let currentJob = null;
	let heartbeatTimer = null;
	let heartbeatInFlight = false;
	let runPromise = null;

	async function heartbeat()
	{
		if (heartbeatInFlight)
		{
			return;
		}

		heartbeatInFlight = true;

		try
		{
			await bounded(
				heartbeatWorker({ workerId, version, jobId: currentJob?.id ?? null, sql }),
				"Sending the worker heartbeat",
			);
		}
		catch (err)
		{
			log.warn(`Worker heartbeat failed: ${err.message}`);
		}
		finally
		{
			heartbeatInFlight = false;
		}
	}

	// Returns true (and sets startupDone) once the stale jobs have been handled
	// under the lock. While
	// another worker holds the lock this is retried on every tick: holding the
	// lock is the only proof that no live worker owns a "running" job.
	async function tryStartup()
	{
		if (!registered)
		{
			await bounded(heartbeatWorker({ workerId, version, sql }), "Registering the worker");

			const removed = await bounded(deleteStaleWorkers({ workerId, sql }), "Removing stale workers");

			registered = true;
			log.info(`Worker ${workerId} registered (${version}); removed ${removed} stale worker row(s)`);
		}

		const lock = await takeLock();

		if (!lock)
		{
			return false;
		}

		// Set before marking, so a late claim that lands meanwhile (and clears
		// it again) is not overwritten.
		startupDone = true;

		try
		{
			const marked = await bounded(markStaleJobsInterrupted({ sql }), "Marking stale jobs interrupted");

			if (marked > 0)
			{
				log.warn(`Marked ${marked} running job(s) from a stopped worker as interrupted`);
			}

			// Recovery and the temp sweep, under the lock (see recoverAtStartup).
			await startupRecovery({ sql, s3, timeoutMs: dbTimeoutMs, shouldStop: () => stopping });
		}
		catch (err)
		{
			startupDone = false;
			throw err;
		}
		finally
		{
			await releaseArchiveLock(lock, dbTimeoutMs);
		}

		return true;
	}

	// Stores the final state, retrying a failed write. Resolves to true when the
	// row is no longer "running" (stored now, or ended by someone else).
	async function storeFinalState(jobId, state, progress, lastError)
	{
		for (let attempt = 1; attempt <= FINISH_ATTEMPTS; attempt++)
		{
			try
			{
				const stored = await bounded(
					finishJob({ jobId, state, progress, lastError, sql }),
					"Finishing the job",
				);

				if (!stored)
				{
					log.warn(`Job ${jobId}: was no longer running when its final state ${state} was stored`);
				}

				return true;
			}
			catch (err)
			{
				log.error(`Job ${jobId}: could not store the final state ${state} (attempt ${attempt}/${FINISH_ATTEMPTS}): ${err.message}`);
			}
		}

		return false;
	}

	async function runJob(job, lock)
	{
		const jobId = job.id;
		const abort = new AbortController();
		let status = null;
		let flusher = null;
		let state = "failed";
		let lastError = null;
		// One progress write at a time, even past a timeout: a write that timed
		// out may still land, and a newer snapshot must not go out before it.
		// While it is pending, later writes are refused (the flusher retries
		// them) rather than queued, so a hung write never holds up the finish.
		let progressWritePending = false;

		currentJob = { id: jobId, abort };

		try
		{
			// A stop that arrived between the claim and here.
			if (stopping)
			{
				abort.abort();
			}

			status = createStatus({
				state: "running",
				startedAt: toIso(job.started_at),
				triggeredBy: job.triggered_by ?? null,
			});
			flusher = createProgressFlusher({
				read: () => status,
				write: (progress) =>
				{
					if (progressWritePending)
					{
						return Promise.reject(new ProgressWriteBusyError());
					}

					const pending = writeJobProgress({ jobId, progress, sql });
					const settle = () =>
					{
						progressWritePending = false;
					};

					progressWritePending = true;
					pending.then(settle, settle);

					return bounded(pending, "Writing job progress");
				},
				intervalMs: flushMs,
				onError: (err) =>
				{
					if (!(err instanceof ProgressWriteBusyError))
					{
						log.warn(`Job ${jobId}: progress write failed: ${err.message}`);
					}
				},
			});
			flusher.start();

			// Recovery before the candidate loop (see recoverAtJobStart).
			await jobStartRecovery({ sql, s3, jobId, timeoutMs: dbTimeoutMs, shouldStop: () => stopping });

			state = await runArchiveJob({
				sql,
				s3,
				lock,
				jobId,
				status,
				timeoutMs: dbTimeoutMs,
				// Aborting kills a running compressor child; that file is left
				// undone, and the job stops before the next one.
				compress: (srcPath, options) => compress(srcPath, { ...options, signal: abort.signal }),
				shouldStop: () => stopping,
				onFileResult: ({ orderId, fileId, result }) =>
				{
					log.info(
						`Job ${jobId}: order ${orderId} file ${fileId ?? "<invalid-id>"} ${result.outcome}` +
						(result.originalSize !== null && result.storedSize !== null
							? ` ${result.originalSize} -> ${result.storedSize} bytes`
							: ""),
					);
					flusher.flush();
				},
			});
			lastError = state === "interrupted" ? INTERRUPTED_ERROR : status.lastError;
		}
		catch (err)
		{
			state = "failed";
			lastError = err.message;

			if (status)
			{
				status.lastError = err.message;
				status.finishedAt = new Date().toISOString();
				status.state = state;
			}
		}
		finally
		{
			try
			{
				await flusher?.stop();

				// The row first, then the lock, so the job never looks abandoned
				// while this worker still holds the lock.
				if (!(await storeFinalState(jobId, state, status ?? { state, lastError }, lastError)))
				{
					// The row may still say "running". Startup runs again on the
					// next tick and marks it interrupted under the lock.
					startupDone = false;
				}
			}
			finally
			{
				await releaseArchiveLock(lock, dbTimeoutMs);
				currentJob = null;
			}
		}

		if (status)
		{
			log.info(
				`Job ${jobId} ${state}: orders ${status.ordersDone}/${status.ordersTotal} done, ${status.ordersFailed} failed; ` +
				`files ${status.filesCompressed} compressed, ${status.filesSkipped} skipped, ` +
				`${status.filesChanged} changed, ${status.filesFailed} failed; ${status.bytesBefore} -> ${status.bytesAfter} bytes`,
			);
		}
	}

	async function pollOnce()
	{
		if (!(await bounded(hasQueuedJob({ sql }), "Polling for queued jobs")))
		{
			return;
		}

		// Busy: another worker runs a job or is starting up. Try again next tick.
		const lock = await takeLock();

		if (!lock)
		{
			return;
		}

		let job = null;

		try
		{
			if (!stopping)
			{
				job = await withTimeout(
					claimQueuedJob({ workerId, sql }),
					"Claiming a queued job",
					dbTimeoutMs,
					(err, row) =>
					{
						// The claim landed after we gave up: a "running" job nobody
						// runs. Startup marks it interrupted on the next tick.
						if (row)
						{
							startupDone = false;
						}
					},
				);
			}
		}
		catch (err)
		{
			// The claim may still land; check for orphaned jobs on the next tick.
			startupDone = false;
			throw err;
		}
		finally
		{
			if (!job)
			{
				await releaseArchiveLock(lock, dbTimeoutMs);
			}
		}

		if (job)
		{
			await runJob(job, lock);
		}
	}

	async function tick()
	{
		if (stopping)
		{
			return;
		}

		try
		{
			if (!startupDone)
			{
				await tryStartup();

				// Also when a late claim cleared the flag during startup: no new
				// job is claimed while an orphaned "running" row waits to be marked.
				if (!startupDone || stopping)
				{
					return;
				}
			}

			await pollOnce();
		}
		catch (err)
		{
			log.warn(`Archiver worker tick failed: ${err.message}`);
		}
	}

	async function loop()
	{
		heartbeatTimer = setInterval(() =>
		{
			heartbeat();
		}, heartbeatMs);
		heartbeatTimer.unref?.();

		try
		{
			while (!stopping)
			{
				await tick();

				try
				{
					await sleep(pollMs, undefined, { signal: stopController.signal });
				}
				catch
				{
					// Woken by stop().
				}
			}
		}
		finally
		{
			clearInterval(heartbeatTimer);
			heartbeatTimer = null;
		}
	}

	return {
		run()
		{
			runPromise ??= loop();

			return runPromise;
		},

		tick,

		async stop()
		{
			stopping = true;
			stopController.abort();
			currentJob?.abort.abort();

			await runPromise;
		},

		isStartupDone: () => startupDone,
	};
}
