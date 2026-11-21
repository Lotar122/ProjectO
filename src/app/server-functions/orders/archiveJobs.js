import "server-only";

import { DB } from "@/app/lib/db";

// Job queue between the web (enqueue, status) and the archiver worker (claim,
// progress, finish). All state lives in archive_jobs / archive_workers /
// archive_pending_verify (db/migrations/2026-11-19_archive_jobs.sql). Every
// function takes the postgres.js client as `sql` so tests can pass a fake.

export const ARCHIVER_BUSY = "ARCHIVER_BUSY";
export const ARCHIVER_WORKER_OFFLINE = "ARCHIVER_WORKER_OFFLINE";

// A worker that has not sent a heartbeat for this long is offline.
export const WORKER_ONLINE_SECONDS = 30;
// A running job whose heartbeat is older than this is reported as stalled.
export const JOB_STALLED_SECONDS = 60;
export const INTERRUPTED_ERROR = "Worker stopped during the job";
// Worker registry rows without a heartbeat for this long are deleted at startup.
const STALE_WORKER_HOURS = 24;

const FINISH_STATES = new Set(["done", "failed", "interrupted"]);

// The counters the worker's createStatus() keeps (orderArchiver.js), so the
// status has every key even for "idle" or a job that has not flushed yet.
const PROGRESS_DEFAULTS = {
	ordersTotal: 0,
	ordersDone: 0,
	ordersFailed: 0,
	ordersArchived: 0,
	ordersChanged: 0,
	filesCompressed: 0,
	filesSkipped: 0,
	filesAlreadyArchived: 0,
	filesIncompressible: 0,
	filesOrphaned: 0,
	filesChanged: 0,
	filesFailed: 0,
	bytesBefore: 0,
	bytesAfter: 0,
};

function assertSql(sql)
{
	if (typeof sql !== "function")
	{
		throw new TypeError("sql must be a postgres.js client");
	}
}

function assertText(value, name)
{
	if (typeof value !== "string" || value === "")
	{
		throw new TypeError(`${name} must be a non-empty string`);
	}
}

function assertJobId(jobId)
{
	if (jobId === null || jobId === undefined || jobId === "")
	{
		throw new TypeError("jobId is required");
	}
}

function toIso(value)
{
	if (value === null || value === undefined)
	{
		return null;
	}

	const date = value instanceof Date ? value : new Date(value);

	return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function toCount(value)
{
	const count = Number(value);

	return Number.isFinite(count) && count >= 0 ? count : 0;
}

// Only the three fields the panel needs. A file id or name never reaches the
// browser, whatever the worker wrote into progress.
function publicCurrentFile(value)
{
	if (!value || typeof value !== "object")
	{
		return null;
	}

	return {
		phase: typeof value.phase === "string" ? value.phase : null,
		bytesDone: toCount(value.bytesDone),
		bytesTotal: toCount(value.bytesTotal),
	};
}

function mapJobRow(row)
{
	if (!row)
	{
		return {
			...PROGRESS_DEFAULTS,
			state: "idle",
			startedAt: null,
			finishedAt: null,
			triggeredBy: null,
			lastError: null,
			currentFile: null,
		};
	}

	const progress = row.progress && typeof row.progress === "object" ? row.progress : {};
	// "stalled" is computed from the heartbeat (by the database clock), never stored.
	const state = row.state === "running" && row.stalled ? "stalled" : row.state;

	// Whitelist: only the known counters, coerced to numbers, reach the browser.
	const counters = Object.fromEntries(
		Object.keys(PROGRESS_DEFAULTS).map((key) => [key, toCount(progress[key])]),
	);

	return {
		...counters,
		state,
		startedAt: toIso(row.started_at),
		finishedAt: toIso(row.finished_at),
		triggeredBy: row.triggered_by ?? null,
		// May contain a file id. Accepted: the endpoint is admin-only and ids are fine in logs.
		lastError: row.last_error ?? progress.lastError ?? null,
		currentFile: publicCurrentFile(progress.currentFile),
	};
}

/**
 * Queues a job. Refused, without inserting, when no worker has sent a
 * heartbeat in the last 30 seconds, or when a job is already queued or running
 * (the partial unique index makes the insert a no-op).
 *
 * The worker check and the insert are separate statements. If the worker goes
 * offline between them, the queued job waits until a worker returns (accepted,
 * section 5.2).
 *
 * @param {object} options
 * @param {string | null} [options.triggeredBy] Admin identity id.
 * @param {Function} [options.sql]
 * @returns {Promise<{ queued: true, jobId: string | number } | { queued: false, reason: "worker-offline" | "busy" }>}
 */
export async function enqueueArchiveJob({ triggeredBy = null, sql = DB } = {})
{
	assertSql(sql);

	if (triggeredBy !== null && typeof triggeredBy !== "string")
	{
		throw new TypeError("triggeredBy must be a string or null");
	}

	const [worker] = await sql`
		SELECT EXISTS (
			SELECT 1 FROM archive_workers
			WHERE heartbeat_at > now() - make_interval(secs => ${WORKER_ONLINE_SECONDS})
		) AS online
	`;

	if (!worker?.online)
	{
		return { queued: false, reason: "worker-offline" };
	}

	const [row] = await sql`
		INSERT INTO archive_jobs (state, triggered_by)
		VALUES ('queued', ${triggeredBy})
		ON CONFLICT DO NOTHING
		RETURNING id
	`;

	if (!row)
	{
		return { queued: false, reason: "busy" };
	}

	return { queued: true, jobId: row.id };
}

/**
 * What the admin panel shows: the latest job mapped to the status shape, the
 * newest worker heartbeat and the number of journal rows that need a person.
 * The candidate count is not included (see countArchiveCandidates).
 *
 * @param {object} [options]
 * @param {Function} [options.sql]
 * @returns {Promise<{ status: object, worker: { online: boolean, version: string | null, heartbeatAt: string | null }, needsAttention: number }>}
 */
export async function getArchiveStatus({ sql = DB } = {})
{
	assertSql(sql);

	const [jobRows, workerRows, attentionRows] = await Promise.all([
		sql`
			SELECT id, state, triggered_by, started_at, finished_at, progress, last_error,
				(state = 'running'
					AND heartbeat_at < now() - make_interval(secs => ${JOB_STALLED_SECONDS})) AS stalled
			FROM archive_jobs
			ORDER BY id DESC
			LIMIT 1
		`,
		sql`
			SELECT version, heartbeat_at,
				heartbeat_at > now() - make_interval(secs => ${WORKER_ONLINE_SECONDS}) AS online
			FROM archive_workers
			ORDER BY heartbeat_at DESC
			LIMIT 1
		`,
		sql`
			SELECT count(*)::int AS count
			FROM archive_pending_verify
			WHERE state = 'needs_attention'
		`,
	]);

	const [workerRow] = workerRows;

	return {
		status: mapJobRow(jobRows[0]),
		worker: {
			online: Boolean(workerRow?.online),
			version: workerRow?.version ?? null,
			heartbeatAt: toIso(workerRow?.heartbeat_at),
		},
		needsAttention: toCount(attentionRows[0]?.count),
	};
}

/**
 * Worker poll: whether a job is queued. A plain pool query, so an idle worker
 * does not reserve a connection or touch the advisory lock every tick.
 *
 * @param {object} [options]
 * @param {Function} [options.sql]
 * @returns {Promise<boolean>}
 */
export async function hasQueuedJob({ sql = DB } = {})
{
	assertSql(sql);

	const rows = await sql`
		SELECT id FROM archive_jobs WHERE state = 'queued' ORDER BY id LIMIT 1
	`;

	return rows.length > 0;
}

/**
 * Worker startup: removes registry rows of workers that have not sent a
 * heartbeat for a day (old containers), never the caller's own row.
 *
 * @param {object} options
 * @param {string} options.workerId The caller, kept even if its row is old.
 * @param {Function} [options.sql]
 * @returns {Promise<number>} How many rows were removed.
 */
export async function deleteStaleWorkers({ workerId, sql = DB })
{
	assertSql(sql);
	assertText(workerId, "workerId");

	const rows = await sql`
		DELETE FROM archive_workers
		WHERE heartbeat_at < now() - make_interval(hours => ${STALE_WORKER_HOURS})
			AND worker_id <> ${workerId}
		RETURNING worker_id
	`;

	return rows.length;
}

/**
 * Worker: turns the oldest queued job into a running one. Call it while
 * holding the archive advisory lock. SKIP LOCKED keeps two claimers from
 * waiting on one row.
 *
 * @param {object} options
 * @param {string} options.workerId
 * @param {Function} [options.sql]
 * @returns {Promise<object | null>} The claimed archive_jobs row, or null when nothing is queued.
 */
export async function claimQueuedJob({ workerId, sql = DB })
{
	assertSql(sql);
	assertText(workerId, "workerId");

	const [row] = await sql`
		UPDATE archive_jobs
		SET state = 'running', started_at = now(), heartbeat_at = now(), worker_id = ${workerId}
		WHERE id = (SELECT id FROM archive_jobs WHERE state = 'queued'
			ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED)
		RETURNING *
	`;

	return row ?? null;
}

/**
 * Worker: stores the job's counters and refreshes its heartbeat.
 *
 * @param {object} options
 * @param {string | number} options.jobId
 * @param {object} options.progress The worker's status object, JSON-serializable.
 * @param {Function} [options.sql]
 * @returns {Promise<boolean>} False when the job is no longer running.
 */
export async function writeJobProgress({ jobId, progress, sql = DB })
{
	assertSql(sql);
	assertJobId(jobId);

	if (!progress || typeof progress !== "object")
	{
		throw new TypeError("progress must be an object");
	}

	const rows = await sql`
		UPDATE archive_jobs
		SET progress = ${sql.json(progress)}, heartbeat_at = now()
		WHERE id = ${jobId} AND state = 'running'
		RETURNING id
	`;

	return rows.length > 0;
}

/**
 * Worker: whether the job is still "running". Read-only, so it never races the
 * worker's own progress writes. False once the job was ended elsewhere (for
 * example marked interrupted by a worker that took over the lock).
 *
 * @param {object} options
 * @param {string | number} options.jobId
 * @param {Function} [options.sql]
 * @returns {Promise<boolean>}
 */
export async function isJobRunning({ jobId, sql = DB })
{
	assertSql(sql);
	assertJobId(jobId);

	const rows = await sql`
		SELECT 1 FROM archive_jobs WHERE id = ${jobId} AND state = 'running'
	`;

	return rows.length > 0;
}

/**
 * Worker shutdown: removes the caller's registry row, so the web stops
 * counting it as online at once instead of up to WORKER_ONLINE_SECONDS later
 * and refuses new jobs while no worker is left. Only for a clean stop; a
 * crashed worker still drops out after WORKER_ONLINE_SECONDS.
 *
 * @param {object} options
 * @param {string} options.workerId
 * @param {Function} [options.sql]
 * @returns {Promise<boolean>} Whether a row was removed.
 */
export async function deregisterWorker({ workerId, sql = DB })
{
	assertSql(sql);
	assertText(workerId, "workerId");

	const rows = await sql`
		DELETE FROM archive_workers
		WHERE worker_id = ${workerId}
		RETURNING worker_id
	`;

	return rows.length > 0;
}

/**
 * Worker: ends a running job.
 *
 * @param {object} options
 * @param {string | number} options.jobId
 * @param {"done" | "failed" | "interrupted"} options.state
 * @param {object} options.progress Final counters.
 * @param {string | null} [options.lastError]
 * @param {Function} [options.sql]
 * @returns {Promise<boolean>} False when the job was not running.
 */
export async function finishJob({ jobId, state, progress, lastError = null, sql = DB })
{
	assertSql(sql);
	assertJobId(jobId);

	if (!FINISH_STATES.has(state))
	{
		throw new RangeError(`state must be one of: ${[...FINISH_STATES].join(", ")}`);
	}

	if (!progress || typeof progress !== "object")
	{
		throw new TypeError("progress must be an object");
	}

	const rows = await sql`
		UPDATE archive_jobs
		SET state = ${state}, finished_at = now(), progress = ${sql.json(progress)},
			last_error = ${lastError}
		WHERE id = ${jobId} AND state = 'running'
		RETURNING id
	`;

	return rows.length > 0;
}

/**
 * Worker startup: marks every running job interrupted. Only call it while
 * holding the archive advisory lock: the lock proves no live worker owns them.
 *
 * @param {object} [options]
 * @param {Function} [options.sql]
 * @returns {Promise<number>} How many jobs were marked.
 */
export async function markStaleJobsInterrupted({ sql = DB } = {})
{
	assertSql(sql);

	const rows = await sql`
		UPDATE archive_jobs
		SET state = 'interrupted', finished_at = now(), last_error = ${INTERRUPTED_ERROR}
		WHERE state = 'running'
		RETURNING id
	`;

	return rows.length;
}

/**
 * Worker: upserts its registry row (this is what makes it "online") and, when
 * it has a job, refreshes the job's heartbeat too.
 *
 * @param {object} options
 * @param {string} options.workerId
 * @param {string} options.version Image tag / git sha and compressor version.
 * @param {string | number | null} [options.jobId] The running job, if any.
 * @param {Function} [options.sql]
 * @returns {Promise<void>}
 */
export async function heartbeatWorker({ workerId, version, jobId = null, sql = DB })
{
	assertSql(sql);
	assertText(workerId, "workerId");
	assertText(version, "version");

	await sql`
		INSERT INTO archive_workers (worker_id, version)
		VALUES (${workerId}, ${version})
		ON CONFLICT (worker_id)
		DO UPDATE SET version = EXCLUDED.version, heartbeat_at = now()
	`;

	if (jobId !== null && jobId !== undefined)
	{
		await sql`
			UPDATE archive_jobs SET heartbeat_at = now()
			WHERE id = ${jobId} AND state = 'running'
		`;
	}
}
