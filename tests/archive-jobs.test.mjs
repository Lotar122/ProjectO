// Job queue (archiveJobs.js) and the admin archiver route.
//
// The module tests use a fake sql that records each statement and answers by
// matching its text; the route tests use the route harness (fake DB queue).
// A real-Postgres variant (partial unique index, SKIP LOCKED) runs only when
// TEST_DB_URL is set; it creates and drops its own schema.

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { readFile, readdir } from "node:fs/promises";
import { callRoute, harness, installRouteHarness, uninstallRouteHarness } from "./helpers/routeHarness.mjs";

await installRouteHarness();

const jobs = await import("../src/app/server-functions/orders/archiveJobs.js");
const candidates = await import("../src/app/server-functions/orders/archiveCandidates.js");
const archiver = await import("../src/app/server-functions/orders/orderArchiver.js");
const { GET, POST } = await import("../src/app/api/admin/archiver/route.js");

afterAll(() =>
{
	uninstallRouteHarness();
});

// ---- fake sql ----

// handler(text, values) returns the rows for a statement; unmatched ones get [].
function fakeSql(handler = () => [])
{
	const queries = [];

	const sql = (strings, ...values) =>
	{
		const text = strings.join("?").replace(/\s+/g, " ").trim();

		queries.push({ text, values });

		return Promise.resolve(handler(text, values) ?? []);
	};

	sql.json = (value) => ({ json: value });
	sql.queries = queries;

	return sql;
}

const ADMIN_ID = "22222222-2222-4222-8222-222222222222";
const KEYS_TODAY = [
	"state", "startedAt", "finishedAt", "triggeredBy", "ordersTotal", "ordersDone", "ordersFailed",
	"ordersArchived", "ordersChanged", "filesCompressed", "filesSkipped", "filesAlreadyArchived",
	"filesIncompressible", "filesOrphaned", "filesChanged", "filesFailed", "bytesBefore",
	"bytesAfter", "lastError",
];

function jobRow(overrides = {})
{
	return {
		id: "7",
		state: "running",
		triggered_by: ADMIN_ID,
		started_at: new Date("2026-11-19T10:00:00Z"),
		finished_at: null,
		progress: { ordersTotal: 10, ordersDone: 4, filesCompressed: 6 },
		last_error: null,
		stalled: false,
		...overrides,
	};
}

describe("enqueueArchiveJob", () =>
{
	test("refuses without inserting when no worker is online", async () =>
	{
		const sql = fakeSql(() => [{ online: false }]);
		const result = await jobs.enqueueArchiveJob({ triggeredBy: ADMIN_ID, sql });

		expect(result).toEqual({ queued: false, reason: "worker-offline" });
		expect(sql.queries.some((query) => query.text.includes("INSERT INTO archive_jobs"))).toBe(false);
		expect(sql.queries[0].values).toEqual([30]);
	});

	test("queues a job for the admin when a worker is online", async () =>
	{
		const sql = fakeSql((text) => (text.includes("INSERT") ? [{ id: "12" }] : [{ online: true }]));
		const result = await jobs.enqueueArchiveJob({ triggeredBy: ADMIN_ID, sql });

		expect(result).toEqual({ queued: true, jobId: "12" });

		const insert = sql.queries.find((query) => query.text.includes("INSERT INTO archive_jobs"));

		expect(insert.text).toContain("'queued'");
		expect(insert.text).toContain("ON CONFLICT DO NOTHING");
		expect(insert.values).toEqual([ADMIN_ID]);
	});

	test("reports busy when the unique index swallows the insert", async () =>
	{
		const sql = fakeSql((text) => (text.includes("INSERT") ? [] : [{ online: true }]));

		expect(await jobs.enqueueArchiveJob({ triggeredBy: ADMIN_ID, sql })).toEqual({
			queued: false,
			reason: "busy",
		});
	});

	test("rejects bad arguments", async () =>
	{
		await expect(jobs.enqueueArchiveJob({ triggeredBy: 5, sql: fakeSql() })).rejects.toThrow(TypeError);
		await expect(jobs.enqueueArchiveJob({ sql: "nope" })).rejects.toThrow(TypeError);
	});
});

describe("getArchiveStatus", () =>
{
	const statusSql = ({ job, worker, attention = 0 }) => fakeSql((text) =>
	{
		if (text.includes("FROM archive_jobs"))
		{
			return job ? [job] : [];
		}

		if (text.includes("FROM archive_workers"))
		{
			return worker ? [worker] : [];
		}

		return [{ count: attention }];
	});

	test("is idle with every counter at zero when there is no job and no worker", async () =>
	{
		const result = await jobs.getArchiveStatus({ sql: statusSql({}) });

		expect(result.status.state).toBe("idle");
		expect(result.status.currentFile).toBeNull();
		expect(result.worker).toEqual({ online: false, version: null, heartbeatAt: null });
		expect(result.needsAttention).toBe(0);

		for (const key of KEYS_TODAY)
		{
			expect(result.status).toHaveProperty(key);
		}
	});

	test("maps a running job: progress, ISO dates, trigger, current file", async () =>
	{
		const row = jobRow({
			progress: {
				ordersTotal: 10,
				ordersDone: 4,
				state: "idle",
				currentFile: { phase: "compress-br", bytesDone: 5, bytesTotal: 9, fileId: "secret-id", name: "x.stl" },
			},
		});
		const { status } = await jobs.getArchiveStatus({ sql: statusSql({ job: row }) });

		expect(status.state).toBe("running");
		expect(status.ordersTotal).toBe(10);
		expect(status.ordersDone).toBe(4);
		expect(status.startedAt).toBe("2026-11-19T10:00:00.000Z");
		expect(status.finishedAt).toBeNull();
		expect(status.triggeredBy).toBe(ADMIN_ID);
		expect(status.currentFile).toEqual({ phase: "compress-br", bytesDone: 5, bytesTotal: 9 });
	});

	test("copies only the known counters and drops every other progress key", async () =>
	{
		const row = jobRow({
			progress: {
				ordersTotal: 10,
				filesCompressed: "not a number",
				bytesBefore: -5,
				fileId: "0190b2a4-0000-7000-8000-00000000000a",
				name: "secret.stl",
				files: ["a", "b"],
				state: "idle",
				startedAt: "forged",
				workerPath: "/work/tmp/x",
			},
		});
		const { status } = await jobs.getArchiveStatus({ sql: statusSql({ job: row }) });
		const allowed = new Set([...KEYS_TODAY, "currentFile"]);

		expect(Object.keys(status).filter((key) => !allowed.has(key))).toEqual([]);
		expect(status.ordersTotal).toBe(10);
		expect(status.filesCompressed).toBe(0);
		expect(status.bytesBefore).toBe(0);
		expect(status.state).toBe("running");
		expect(status.startedAt).toBe("2026-11-19T10:00:00.000Z");
		expect(JSON.stringify(status)).not.toMatch(/secret\.stl|0190b2a4|workerPath|\/work\/tmp/);
	});

	test("reports stalled only for a running job with an old heartbeat", async () =>
	{
		const stalled = await jobs.getArchiveStatus({ sql: statusSql({ job: jobRow({ stalled: true }) }) });
		const doneButOld = await jobs.getArchiveStatus({
			sql: statusSql({ job: jobRow({ state: "done", stalled: true }) }),
		});

		expect(stalled.status.state).toBe("stalled");
		expect(doneButOld.status.state).toBe("done");
	});

	test("computes stalled in SQL from a 60 s heartbeat age", async () =>
	{
		const sql = statusSql({});

		await jobs.getArchiveStatus({ sql });

		const query = sql.queries.find((entry) => entry.text.includes("FROM archive_jobs"));

		expect(query.text).toContain("ORDER BY id DESC LIMIT 1");
		expect(query.text).toContain("heartbeat_at < now()");
		expect(query.values).toEqual([60]);
	});

	test.each(["queued", "done", "failed", "interrupted"])("passes %s through", async (state) =>
	{
		const row = jobRow({ state, finished_at: new Date("2026-11-19T10:05:00Z"), last_error: "boom" });
		const { status } = await jobs.getArchiveStatus({ sql: statusSql({ job: row }) });

		expect(status.state).toBe(state);
		expect(status.lastError).toBe("boom");
		expect(status.finishedAt).toBe("2026-11-19T10:05:00.000Z");
	});

	test("falls back to the last file error from progress", async () =>
	{
		const row = jobRow({ progress: { lastError: "file 3 failed" }, last_error: null });
		const { status } = await jobs.getArchiveStatus({ sql: statusSql({ job: row }) });

		expect(status.lastError).toBe("file 3 failed");
	});

	test("maps the worker and the needs-attention count", async () =>
	{
		const result = await jobs.getArchiveStatus({
			sql: statusSql({
				job: jobRow(),
				worker: { version: "abc1234 / projecto-compress 1.0.0", heartbeat_at: new Date("2026-11-19T10:00:05Z"), online: true },
				attention: 2,
			}),
		});

		expect(result.worker).toEqual({
			online: true,
			version: "abc1234 / projecto-compress 1.0.0",
			heartbeatAt: "2026-11-19T10:00:05.000Z",
		});
		expect(result.needsAttention).toBe(2);
	});

	test("an old worker heartbeat is offline but still reports its version", async () =>
	{
		const result = await jobs.getArchiveStatus({
			sql: statusSql({ worker: { version: "v1", heartbeat_at: new Date("2026-11-19T09:00:00Z"), online: false } }),
		});

		expect(result.worker.online).toBe(false);
		expect(result.worker.version).toBe("v1");
	});
});

describe("worker-side queries", () =>
{
	test("claimQueuedJob claims the oldest queued row with SKIP LOCKED", async () =>
	{
		const sql = fakeSql(() => [jobRow()]);
		const row = await jobs.claimQueuedJob({ workerId: "w1", sql });

		expect(row.id).toBe("7");
		expect(sql.queries[0].text).toContain("SET state = 'running'");
		expect(sql.queries[0].text).toContain("WHERE state = 'queued' ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED");
		expect(sql.queries[0].values).toEqual(["w1"]);
	});

	test("claimQueuedJob returns null when nothing is queued and checks the worker id", async () =>
	{
		expect(await jobs.claimQueuedJob({ workerId: "w1", sql: fakeSql() })).toBeNull();
		await expect(jobs.claimQueuedJob({ workerId: "", sql: fakeSql() })).rejects.toThrow(TypeError);
	});

	test("writeJobProgress stores json only while the job runs", async () =>
	{
		const progress = { ordersDone: 1 };
		const written = fakeSql(() => [{ id: "7" }]);
		const gone = fakeSql(() => []);

		expect(await jobs.writeJobProgress({ jobId: "7", progress, sql: written })).toBe(true);
		expect(await jobs.writeJobProgress({ jobId: "7", progress, sql: gone })).toBe(false);
		expect(written.queries[0].text).toContain("AND state = 'running'");
		expect(written.queries[0].values).toEqual([{ json: progress }, "7"]);
		await expect(jobs.writeJobProgress({ jobId: "7", progress: null, sql: written })).rejects.toThrow(TypeError);
	});

	test("finishJob accepts the three end states only", async () =>
	{
		const sql = fakeSql(() => [{ id: "7" }]);

		for (const state of ["done", "failed", "interrupted"])
		{
			expect(await jobs.finishJob({ jobId: "7", state, progress: {}, sql })).toBe(true);
		}

		await expect(jobs.finishJob({ jobId: "7", state: "running", progress: {}, sql })).rejects.toThrow(RangeError);
		await expect(jobs.finishJob({ jobId: "7", state: "queued", progress: {}, sql })).rejects.toThrow(RangeError);
		expect(sql.queries).toHaveLength(3);
		expect(sql.queries[0].text).toContain("finished_at = now()");
		expect(sql.queries[0].values).toEqual(["done", { json: {} }, null, "7"]);
		expect(await jobs.finishJob({ jobId: "7", state: "failed", progress: {}, lastError: "x", sql: fakeSql() })).toBe(false);
	});

	test("markStaleJobsInterrupted marks running jobs and counts them", async () =>
	{
		const sql = fakeSql(() => [{ id: "7" }, { id: "8" }]);

		expect(await jobs.markStaleJobsInterrupted({ sql })).toBe(2);
		expect(sql.queries[0].text).toContain("SET state = 'interrupted'");
		expect(sql.queries[0].text).toContain("WHERE state = 'running'");
		expect(sql.queries[0].values).toEqual(["Worker stopped during the job"]);
	});

	test("heartbeatWorker upserts the worker and touches the job only when given one", async () =>
	{
		const idle = fakeSql();
		const busy = fakeSql();

		await jobs.heartbeatWorker({ workerId: "w1", version: "v1", sql: idle });
		await jobs.heartbeatWorker({ workerId: "w1", version: "v1", jobId: "7", sql: busy });

		expect(idle.queries).toHaveLength(1);
		expect(idle.queries[0].text).toContain("ON CONFLICT (worker_id) DO UPDATE");
		expect(idle.queries[0].values).toEqual(["w1", "v1"]);
		expect(busy.queries).toHaveLength(2);
		expect(busy.queries[1].text).toContain("UPDATE archive_jobs SET heartbeat_at = now()");
		expect(busy.queries[1].values).toEqual(["7"]);
		await expect(jobs.heartbeatWorker({ workerId: "w1", version: "", sql: idle })).rejects.toThrow(TypeError);
	});
});

describe("archiveCandidates", () =>
{
	test("selects and counts with the 30 day predicate", async () =>
	{
		const rows = [{ order_id: 1, files: ["a"] }];
		const selecting = fakeSql(() => rows);
		const counting = fakeSql(() => [{ count: 3 }]);

		expect(await candidates.selectArchiveCandidates(selecting)).toBe(rows);
		expect(selecting.queries[0].values).toEqual([candidates.ARCHIVE_AFTER_DAYS]);
		expect(selecting.queries[0].text).toContain("archived_at IS NULL");
		expect(await candidates.countArchiveCandidates(counting)).toBe(3);
		expect(await candidates.countArchiveCandidates(fakeSql())).toBe(0);
	});

	test("orderArchiver.js re-exports the same functions", () =>
	{
		expect(archiver.selectArchiveCandidates).toBe(candidates.selectArchiveCandidates);
		expect(archiver.countArchiveCandidates).toBe(candidates.countArchiveCandidates);
		expect(archiver.ARCHIVE_AFTER_DAYS).toBe(candidates.ARCHIVE_AFTER_DAYS);
	});
});

// ---- admin route ----

const JOB_QUERIES = () => [[jobRow()], [{ version: "v1", heartbeat_at: new Date("2026-11-19T10:00:05Z"), online: true }], [{ count: 1 }]];

function logInAsAdmin()
{
	harness.session.loggedIn = true;
	harness.session.userId = ADMIN_ID;
	harness.session.role = "admin";
}

describe("admin archiver route", () =>
{
	beforeEach(() =>
	{
		harness.reset();
	});

	test("the web does not import orderArchiver.js", async () =>
	{
		const files = await readdir(new URL("../src/app/api", import.meta.url), { recursive: true });
		const offenders = [];

		for (const file of files.filter((name) => /\.(js|mjs|jsx)$/.test(name)))
		{
			const text = await readFile(new URL(`../src/app/api/${file}`, import.meta.url), "utf8");

			if (text.includes("orderArchiver"))
			{
				offenders.push(file);
			}
		}

		expect(offenders).toEqual([]);
	});

	test.each([
		["GET", GET],
		["POST", POST],
	])("%s needs an admin", async (method, handler) =>
	{
		const anonymous = await callRoute(handler, { method });

		harness.session.loggedIn = true;
		harness.session.role = "user";

		const regular = await callRoute(handler, { method });

		expect(anonymous.status).toBe(403);
		expect(regular.status).toBe(403);
		expect(harness.db.queries).toHaveLength(0);
	});

	test("GET returns today's keys plus worker, needsAttention and candidates", async () =>
	{
		logInAsAdmin();
		harness.db.queue(...JOB_QUERIES(), [{ count: 12 }]);

		const response = await callRoute(GET);
		const body = await response.json();

		expect(response.status).toBe(200);
		expect(Object.keys(body).sort()).toEqual(["candidates", "needsAttention", "status", "success", "worker"]);
		expect(body.success).toBe(true);
		expect(body.candidates).toBe(12);
		expect(body.needsAttention).toBe(1);
		expect(body.worker).toEqual({ online: true, version: "v1", heartbeatAt: "2026-11-19T10:00:05.000Z" });
		expect(body.status.state).toBe("running");

		for (const key of KEYS_TODAY)
		{
			expect(body.status).toHaveProperty(key);
		}
	});

	test("GET answers 500 when the database fails", async () =>
	{
		logInAsAdmin();
		harness.db.queue(new Error("connection lost"));

		expect((await callRoute(GET)).status).toBe(500);
	});

	test("POST queues a job and answers 202 with the queued status", async () =>
	{
		logInAsAdmin();
		harness.db.queue([{ online: true }], [{ id: "9" }], [jobRow({ state: "queued", started_at: null, progress: {} })], [], [{ count: 0 }]);

		const response = await callRoute(POST, { method: "POST" });
		const body = await response.json();
		const insert = harness.db.queries.find((query) => query.text.includes("INSERT INTO archive_jobs"));

		expect(response.status).toBe(202);
		expect(body.success).toBe(true);
		expect(body.status.state).toBe("queued");
		expect(insert.values).toEqual([ADMIN_ID]);
	});

	test("POST answers 409 ARCHIVER_BUSY with the current status", async () =>
	{
		logInAsAdmin();
		harness.db.queue([{ online: true }], [], ...JOB_QUERIES());

		const response = await callRoute(POST, { method: "POST" });
		const body = await response.json();

		expect(response.status).toBe(409);
		expect(body.success).toBe(false);
		expect(body.code).toBe("ARCHIVER_BUSY");
		expect(body.status.state).toBe("running");
	});

	test("POST answers 503 ARCHIVER_WORKER_OFFLINE and inserts nothing", async () =>
	{
		logInAsAdmin();
		harness.db.queue([{ online: false }]);

		const response = await callRoute(POST, { method: "POST" });
		const body = await response.json();

		expect(response.status).toBe(503);
		expect(body.code).toBe("ARCHIVER_WORKER_OFFLINE");
		expect(harness.db.queries.some((query) => query.text.includes("INSERT"))).toBe(false);
	});

	test("POST still answers 202 when the status read after the insert fails", async () =>
	{
		logInAsAdmin();
		harness.db.queue([{ online: true }], [{ id: "9" }], new Error("read failed"));

		const response = await callRoute(POST, { method: "POST" });

		expect(response.status).toBe(202);
		expect((await response.json()).status).toBeNull();
	});
});

// ---- real Postgres (optional) ----

const TEST_DB_URL = process.env.TEST_DB_URL;

if (!TEST_DB_URL)
{
	console.log("archive-jobs: TEST_DB_URL is not set; skipping the real-Postgres tests");
}

describe.skipIf(!TEST_DB_URL)("archive jobs on Postgres", () =>
{
	const schema = `archive_jobs_test_${process.pid}`;
	let admin;
	let sql;

	test("setup: apply the migration into a scratch schema", async () =>
	{
		const { default: postgres } = await import("postgres");
		const migration = await readFile(new URL("../db/migrations/2026-11-19_archive_jobs.sql", import.meta.url), "utf8");

		admin = postgres(TEST_DB_URL, { max: 1 });
		await admin.unsafe(`CREATE SCHEMA ${schema}`);
		sql = postgres(TEST_DB_URL, { max: 4, connection: { search_path: schema } });

		// The migration file has its own BEGIN/COMMIT, which postgres.js refuses on a pooled
		// connection (UNSAFE_TRANSACTION). A reserved connection keeps the search_path and is
		// released even if the migration fails.
		const reserved = await sql.reserve();

		try
		{
			await reserved.unsafe(migration);
			// Running it twice must be a no-op.
			await reserved.unsafe(migration);
		}
		finally
		{
			reserved.release();
		}
	});

	test("the unique index allows one active job; SKIP LOCKED claims it once", async () =>
	{
		await jobs.heartbeatWorker({ workerId: "w1", version: "test", sql });

		const first = await jobs.enqueueArchiveJob({ triggeredBy: ADMIN_ID, sql });
		const second = await jobs.enqueueArchiveJob({ triggeredBy: ADMIN_ID, sql });

		expect(first.queued).toBe(true);
		expect(second).toEqual({ queued: false, reason: "busy" });

		const [claimA, claimB] = await Promise.all([
			jobs.claimQueuedJob({ workerId: "w1", sql }),
			jobs.claimQueuedJob({ workerId: "w2", sql }),
		]);

		expect([claimA, claimB].filter(Boolean)).toHaveLength(1);

		const { status } = await jobs.getArchiveStatus({ sql });

		expect(status.state).toBe("running");
		expect(await jobs.writeJobProgress({ jobId: first.jobId, progress: { ordersTotal: 3 }, sql })).toBe(true);
		expect(await jobs.finishJob({ jobId: first.jobId, state: "done", progress: { ordersTotal: 3 }, sql })).toBe(true);
		expect((await jobs.getArchiveStatus({ sql })).status.state).toBe("done");
		expect((await jobs.enqueueArchiveJob({ triggeredBy: ADMIN_ID, sql })).queued).toBe(true);
	});

	test("markStaleJobsInterrupted and a stale worker heartbeat", async () =>
	{
		await jobs.claimQueuedJob({ workerId: "w1", sql });
		expect(await jobs.markStaleJobsInterrupted({ sql })).toBe(1);
		expect((await jobs.getArchiveStatus({ sql })).status.state).toBe("interrupted");

		await sql`UPDATE archive_workers SET heartbeat_at = now() - interval '5 minutes'`;
		expect((await jobs.getArchiveStatus({ sql })).worker.online).toBe(false);
		expect(await jobs.enqueueArchiveJob({ triggeredBy: null, sql })).toEqual({ queued: false, reason: "worker-offline" });
	});

	test("teardown", async () =>
	{
		await sql?.end();
		await admin?.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
		await admin?.end();
	});
});
