import { setTimeout as sleep } from "node:timers/promises";

import { createLogger } from "@/app/lib/logger";
import {
	INTERRUPTED_ERROR,
	claimQueuedJob,
	deleteStaleWorkers,
	deregisterWorker,
	finishJob,
	hasQueuedJob,
	heartbeatWorker,
	isJobRunning,
	markStaleJobsInterrupted,
	writeJobProgress,
} from "@/app/server-functions/orders/archiveJobs";
import {
	DB_TIMEOUT_MS,
	TEMP_SWEEP_MIN_AGE_MS,
	acquireArchiveLock,
	createStatus,
	recoverPendingVerifications,
	releaseArchiveLock,
	runArchiveJob,
	sweepTempDir,
	withTimeout,
} from "@/app/server-functions/orders/orderArchiver";

import { touchLivenessFile } from "./liveness.js";
import { createProgressFlusher } from "./progressFlusher.js";

// The archiver worker's runtime (phases-bugfix/phase4.md 5.2 and 9.6): startup
// cleanup under the advisory lock, a poll loop that claims queued jobs under
// the lock, progress and heartbeat timers, and a graceful stop. main.js wires
// it to the real database, S3 client and compressor.
//
// While a job runs, every heartbeat also checks that this worker still owns
// it: the job row is still "running" and the lock session still holds the
// advisory lock. A progress write that finds the row ended does the same. On
// a loss the job is aborted (the compressor is killed, no further file
// starts), because another worker may already be recovering the same files.

export const POLL_MS = 5_000;
export const FLUSH_MS = 2_000;
export const HEARTBEAT_MS = 10_000;
// Upper bound for the startup retry delay while another worker holds the lock,
// so an idle replica does not open a lock connection every poll.
export const STARTUP_RETRY_MAX_MS = 60_000;
// Tries to store a job's final state before giving up and releasing the lock.
const FINISH_ATTEMPTS = 3;
// Ownership checks that may fail in a row (a query error, not a "lost"
// answer) before the job is treated as lost: a dead lock connection can hang
// rather than answer.
const OWNERSHIP_CHECK_FAILURES = 3;
// Least time between two temp sweeps while the worker is idle. The sweep keeps
// files younger than TEMP_SWEEP_MIN_AGE_MS, so a file the startup sweep had to
// keep (a restart within that time) is old enough by the next idle sweep.
export const IDLE_SWEEP_MS = TEMP_SWEEP_MIN_AGE_MS;

// Crash recovery (phases-bugfix/phase4.md 9.3, 9.4). Both run while this
// worker holds the archive lock, with the shared pool (never the lock client).
// - Startup, after the stale jobs are marked: settle the journal, then sweep
//   the temp directory (the sweep keeps every original a row still references).
// - Job start, before the candidate loop, so no order is marked while one of
//   its files still has a journal row. A failure here fails the job.
// The temp directory is also swept at each job start (after this recovery)
// and while idle; see sweepTemp in createArchiveWorker.
async function recoverAtStartup({ sql, s3, timeoutMs, shouldStop })
{
	await recoverPendingVerifications(sql, s3, { timeoutMs, shouldStop });
	await sweepTempDir({ sql, timeoutMs });
}

function sweepTemp({ sql, timeoutMs })
{
	return sweepTempDir({ sql, timeoutMs });
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

// Whether the lock client's session still holds an advisory lock. The session
// only ever holds the archive lock, and a reconnected client has a new backend
// pid. Reads pg_locks instead of calling pg_try_advisory_lock, so the check
// takes no extra hold.
async function isLockHeld(lock)
{
	const [row] = await lock.client`
		SELECT pg_backend_pid() AS pid,
			EXISTS (
				SELECT 1 FROM pg_locks
				WHERE locktype = 'advisory' AND pid = pg_backend_pid() AND granted
			) AS locked
	`;

	return row?.pid === lock.pid && row?.locked === true;
}

/**
 * @typedef {object} ArchiveWorker
 * @property {() => Promise<void>} run Runs startup and the poll loop until stop(); resolves once stopped.
 * @property {() => Promise<void>} tick One poll iteration (finishes startup first if it is still pending). Never throws.
 * @property {() => Promise<void>} stop Graceful stop (9.6); resolves once run() has returned
 *   and the worker's registry row is removed.
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
 * @param {number} [options.startupRetryMaxMs] Longest wait between startup attempts in run()
 *   while another worker holds the lock (doubles from pollMs).
 * @param {string | null} [options.livenessFile] Rewritten after each successful heartbeat
 *   (see liveness.js); null to skip.
 * @param {{ info: Function, warn: Function, error: Function }} [options.log]
 * @param {(context: { sql: Function, s3: object, timeoutMs: number, shouldStop: () => boolean }) => Promise<void>} [options.recoverAtStartup]
 *   Crash recovery and temp sweep at startup; tests pass a fake.
 * @param {(context: { sql: Function, s3: object, jobId: string | number, timeoutMs: number, shouldStop: () => boolean }) => Promise<void>} [options.recoverAtJobStart]
 *   Crash recovery before each job's candidate loop; tests pass a fake.
 * @param {(context: { sql: Function, timeoutMs: number }) => Promise<unknown>} [options.sweepTemp]
 *   Temp sweep (sweepTempDir) run under the lock at each job start, after
 *   recoverAtJobStart, and while idle; tests pass a fake. Its failures are logged, never fatal.
 * @param {number} [options.idleSweepMs] Least time between two sweeps while idle (IDLE_SWEEP_MS);
 *   counted from the last sweep of any kind.
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
	startupRetryMaxMs = STARTUP_RETRY_MAX_MS,
	livenessFile = null,
	openLockClient,
	log = createLogger("archiver-worker"),
	recoverAtStartup: startupRecovery = recoverAtStartup,
	recoverAtJobStart: jobStartRecovery = recoverAtJobStart,
	sweepTemp: tempSweep = sweepTemp,
	idleSweepMs = IDLE_SWEEP_MS,
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
	assertInterval(startupRetryMaxMs, "startupRetryMaxMs");
	assertInterval(idleSweepMs, "idleSweepMs");

	if (typeof tempSweep !== "function")
	{
		throw new TypeError("sweepTemp must be a function");
	}

	if (livenessFile !== null && (typeof livenessFile !== "string" || livenessFile === ""))
	{
		throw new TypeError("livenessFile must be a non-empty string or null");
	}

	const bounded = (promise, label) => withTimeout(promise, label, dbTimeoutMs);
	const takeLock = () => acquireArchiveLock({ timeoutMs: dbTimeoutMs, ...(openLockClient ? { openClient: openLockClient } : {}) });
	const stopController = new AbortController();
	let stopping = false;
	let registered = false;
	let startupDone = false;
	// Startup attempts in a row that found the lock held by someone else.
	let startupBusyCount = 0;
	let currentJob = null;
	let heartbeatTimer = null;
	let heartbeatPromise = null;
	let livenessFailed = false;
	let runPromise = null;
	let stopPromise = null;
	// When the temp directory was last swept (or an idle sweep last tried),
	// in ms since the epoch; 0 until startup has swept.
	let lastSweepAt = 0;

	// Temp sweep under the lock the caller holds (review 2026-11-20: the
	// startup sweep alone keeps files younger than TEMP_SWEEP_MIN_AGE_MS, so a
	// worker restarted within that time left them for nothing to remove).
	// Keeps every original a journal row references and every recent file.
	async function sweepUnderLock(when)
	{
		lastSweepAt = Date.now();

		try
		{
			await tempSweep({ sql, timeoutMs: dbTimeoutMs });
		}
		catch (err)
		{
			log.warn(`Temp sweep ${when} failed: ${err.message}`);
		}
	}

	// While idle, at most once per idleSweepMs. Takes the lock only for the
	// sweep and skips it when another worker holds the lock (busy).
	async function sweepWhenIdle()
	{
		if (stopping || Date.now() - lastSweepAt < idleSweepMs)
		{
			return;
		}

		// Counted as a try even when the lock is busy, so an idle replica does
		// not open a lock connection on every poll.
		lastSweepAt = Date.now();

		const lock = await takeLock();

		if (!lock)
		{
			return;
		}

		try
		{
			await sweepUnderLock("while idle");
		}
		finally
		{
			await releaseArchiveLock(lock, dbTimeoutMs);
		}
	}

	async function markAlive()
	{
		if (livenessFile === null)
		{
			return;
		}

		try
		{
			await touchLivenessFile(livenessFile);
			livenessFailed = false;
		}
		catch (err)
		{
			// Logged once per run of failures; the health check reports it anyway.
			if (!livenessFailed)
			{
				log.warn(`Could not write the liveness file: ${err.message}`);
			}

			livenessFailed = true;
		}
	}

	// Aborts job when this worker no longer owns it; see the top note.
	async function checkJobOwnership(job)
	{
		const [running, lockHeld] = await Promise.allSettled([
			bounded(isJobRunning({ jobId: job.id, sql }), "Checking the job state"),
			bounded(isLockHeld(job.lock), "Checking the archive lock"),
		]);

		if (running.status === "fulfilled" && running.value === false)
		{
			job.lose("the job row is no longer running (ended elsewhere)");
			return;
		}

		if (running.status === "rejected")
		{
			// The pool may be briefly unavailable; the lock check below decides.
			log.warn(`Job ${job.id}: could not check the job state: ${running.reason?.message}`);
		}

		if (lockHeld.status === "fulfilled")
		{
			job.checkFailures = 0;

			if (!lockHeld.value)
			{
				job.lose("lost the archive lock");
			}

			return;
		}

		job.checkFailures++;
		log.warn(
			`Job ${job.id}: could not check the archive lock (${job.checkFailures}/${OWNERSHIP_CHECK_FAILURES}): ` +
			`${lockHeld.reason?.message}`,
		);

		if (job.checkFailures >= OWNERSHIP_CHECK_FAILURES)
		{
			job.lose(`could not confirm the archive lock ${OWNERSHIP_CHECK_FAILURES} times in a row`);
		}
	}

	async function sendHeartbeat()
	{
		const job = currentJob;

		try
		{
			await bounded(
				heartbeatWorker({ workerId, version, jobId: job?.id ?? null, sql }),
				"Sending the worker heartbeat",
			);
			await markAlive();
		}
		catch (err)
		{
			log.warn(`Worker heartbeat failed: ${err.message}`);
		}

		if (job && !job.finishing)
		{
			await checkJobOwnership(job);
		}
	}

	// One heartbeat at a time; the promise lets stop() wait for it.
	function heartbeat()
	{
		heartbeatPromise ??= sendHeartbeat().finally(() =>
		{
			heartbeatPromise = null;
		});

		return heartbeatPromise;
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
			await markAlive();

			const removed = await bounded(deleteStaleWorkers({ workerId, sql }), "Removing stale workers");

			registered = true;
			log.info(`Worker ${workerId} registered (${version}); removed ${removed} stale worker row(s)`);
		}

		const lock = await takeLock();

		if (!lock)
		{
			startupBusyCount++;
			return false;
		}

		startupBusyCount = 0;
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
			lastSweepAt = Date.now();
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
					// Someone else ended the row (only possible after this worker
					// lost the lock): their state stays.
					log.warn(`Job ${jobId}: was no longer running when its final state ${state} was stored; ended elsewhere`);
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
		// Why this worker no longer owns the job, or null.
		let lostReason = null;
		// What the heartbeat sees of this job (currentJob).
		const owned = {
			id: jobId,
			abort,
			lock,
			checkFailures: 0,
			// Set once the job's own work is over: a check from then on proves nothing.
			finishing: false,
			lose(reason)
			{
				if (lostReason !== null || owned.finishing)
				{
					return;
				}

				lostReason = reason;
				log.error(`Job ${jobId}: ${reason}; aborting the job`);
				// No reason argument: the AbortError is what runArchiveJob treats as a stop.
				abort.abort();
			},
		};

		currentJob = owned;

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

					return bounded(pending, "Writing job progress").then((stillRunning) =>
					{
						if (stillRunning === false)
						{
							owned.lose("the job row is no longer running (ended elsewhere)");
						}

						return stillRunning;
					});
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

			const shouldStop = () => stopping || lostReason !== null;

			// Recovery before the candidate loop (see recoverAtJobStart), then
			// the temp sweep: after recovery, so the originals of the rows it
			// cleared go too, and before this job writes any temp file.
			await jobStartRecovery({ sql, s3, jobId, timeoutMs: dbTimeoutMs, shouldStop });
			await sweepUnderLock("at job start");

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
				shouldStop,
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
			owned.finishing = true;

			// A lost job failed, whatever runArchiveJob made of the stop. The row
			// is only written if nobody else has ended it (finishJob checks).
			if (lostReason !== null)
			{
				state = "failed";
				lastError = `Lost ownership of the job: ${lostReason}`;

				if (status)
				{
					status.lastError = lastError;
					status.state = state;
					status.finishedAt ??= new Date().toISOString();
				}
			}

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
			await sweepWhenIdle();
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

				// While another worker holds the lock, startup is retried with
				// a doubling delay instead of a new lock connection every poll.
				const waitMs = startupDone || startupBusyCount === 0
					? pollMs
					: Math.min(pollMs * 2 ** Math.min(startupBusyCount, 20), Math.max(startupRetryMaxMs, pollMs));

				try
				{
					await sleep(waitMs, undefined, { signal: stopController.signal });
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

	async function stopGracefully()
	{
		stopping = true;
		stopController.abort();
		currentJob?.abort.abort();

		await runPromise;

		if (!registered)
		{
			return;
		}

		// A heartbeat still in flight would re-insert the row after the delete.
		await heartbeatPromise;

		// Offline at once, so the web refuses new jobs instead of queueing them
		// for a worker that is gone. Best effort: the row still goes stale.
		try
		{
			await bounded(deregisterWorker({ workerId, sql }), "Removing the worker row");
		}
		catch (err)
		{
			log.warn(`Could not remove the worker row: ${err.message}`);
		}
	}

	return {
		run()
		{
			runPromise ??= loop();

			return runPromise;
		},

		tick,

		stop()
		{
			stopPromise ??= stopGracefully();

			return stopPromise;
		},

		isStartupDone: () => startupDone,
	};
}
