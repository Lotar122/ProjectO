// Archiver worker runtime (worker/archiver/archiveWorker.js) against a fake
// Postgres (stateful job rows, worker rows, orders and a shared advisory lock)
// and the HTTP S3 stand-in. The job/lock tests are ported from
// order-archiver.test.mjs, where they drove the removed in-process
// startArchiveJob.
//
// Not covered here: a real Postgres / MinIO run of `bun run worker:archiver`
// (no database on this machine; see phase4-amendments.md A8).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";

import { INTERRUPTED_ERROR, deleteStaleWorkers, getArchiveStatus, hasQueuedJob } from "../src/app/server-functions/orders/archiveJobs.js";
import {
	FILE_OUTCOMES,
	createStatus,
	recordFileResult,
	releaseArchiveLock,
} from "../src/app/server-functions/orders/orderArchiver.js";
import { createArchiveWorker } from "../worker/archiver/archiveWorker.js";
import { readCompressorVersion } from "../worker/archiver/compressorVersion.js";
import { createProgressFlusher } from "../worker/archiver/progressFlusher.js";
import { createFakeJournal } from "./helpers/fakeJournal.mjs";
import { withS3 } from "./helpers/s3Server.mjs";
import { TEST_ENCODER, testCompressor } from "./helpers/testCompressor.mjs";

const ADMIN_ID = "22222222-2222-4222-8222-222222222222";
const FILE_A = "01900000-0000-7000-8000-00000000000a";
const FILE_B = "01900000-0000-7000-8000-00000000000b";
const FILE_C = "01900000-0000-7000-8000-00000000000c";
const FILE_NAME = "Skan górny.stl";

const sha = (data) => createHash("sha256").update(data).digest("hex");
const hang = () => new Promise(() => undefined);
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Counters only; lastError, state and the timestamps are compared separately.
const COUNTER_KEYS = Object.keys(createStatus()).filter((key) => /^(orders|files|bytes)/.test(key));

async function waitFor(predicate, label, timeoutMs = 5000)
{
	const deadline = Date.now() + timeoutMs;

	while (!(await predicate()))
	{
		if (Date.now() > deadline)
		{
			throw new Error(`Timed out waiting for ${label}`);
		}

		await delay(5);
	}
}

function compressibleData(seed = 0)
{
	const lines = [];

	for (let i = 0; i < 3000; i++)
	{
		lines.push(`  facet normal ${(i % 11) / 11} ${seed} 1\n    vertex ${i} ${i * 3} ${i % 9}\n  endfacet\n`);
	}

	return Buffer.from(lines.join(""));
}

function seedFile(objects, fileId, body)
{
	objects.set(fileId, {
		body,
		contentType: "model/stl",
		metadata: { original_name: encodeURIComponent(FILE_NAME), sha256: sha(body) },
	});
}

// ---- isolated temp dir (the archiver writes to os.tmpdir()) ----

const TEMP_ENV_NAMES = ["TMPDIR", "TEMP", "TMP"];
let tempDir;
let previousTempEnv;

beforeEach(async () =>
{
	tempDir = await mkdtemp(path.join(os.tmpdir(), "projecto-worker-test-"));
	previousTempEnv = TEMP_ENV_NAMES.map((name) => [name, process.env[name]]);

	for (const name of TEMP_ENV_NAMES)
	{
		process.env[name] = tempDir;
	}
});

afterEach(async () =>
{
	for (const [name, value] of previousTempEnv)
	{
		if (value === undefined)
		{
			delete process.env[name];
		}
		else
		{
			process.env[name] = value;
		}
	}

	await rm(tempDir, { recursive: true, force: true });
});

const archiverTempFiles = async () => (await readdir(tempDir)).filter((name) => name.startsWith("projecto-archive-"));

// ---- fake Postgres ----

// The advisory lock as the ported lockHandler saw it: the first lock query on
// a connection takes it, later ones (confirmArchiveLock) answer confirm().
function lockHandler({ confirm, unlock } = {})
{
	return ({ db, connection }) =>
	{
		let lockCalls = 0;

		return (text) =>
		{
			if (text.includes("pg_try_advisory_lock"))
			{
				lockCalls++;

				if (lockCalls > 1 && confirm)
				{
					return confirm();
				}

				return Promise.resolve(db.tryLock(connection));
			}

			if (text.includes("pg_advisory_unlock_all"))
			{
				return unlock ? unlock() : Promise.resolve(db.unlockAll(connection));
			}

			return Promise.resolve([]);
		};
	};
}

// One database shared by every client created from it. db.client() is a
// process's shared pool. db.openLockClient() is a dedicated one-connection
// client with its own session (backend pid), like the archiver's lock client:
// end() closes the session and releases its locks, and a closed or killed
// session rejects every query. The advisory lock belongs to one session at a
// time and is re-entrant, like a Postgres session lock.
function createFakeDb({ jobs = [], orders = [] } = {})
{
	const db = {
		jobs: jobs.map((job) => ({ progress: {}, triggered_by: ADMIN_ID, worker_id: null, last_error: null, ...job })),
		orders: orders.map((order) => ({ archived_at: null, ...order })),
		workers: new Map(),
		lockOwner: null,
		lockRefusals: 0,
		progressWrites: [],
		heartbeats: 0,
		// Test knobs: hold a statement until the promise settles, fail finishJob
		// n times, run a callback when a job is claimed.
		progressGate: null,
		claimGate: null,
		finishFailures: 0,
		onClaim: null,
		connections: [],
		nextPid: 100,
		// Builds the handler for a new lock client.
		connectionHandler: lockHandler(),
		// archive_pending_verify (crash journal), shared with the orders above.
		journal: null,

		tryLock(connection)
		{
			if (db.lockOwner === null || db.lockOwner === connection)
			{
				db.lockOwner = connection;
				return [{ pid: connection.pid, locked: true }];
			}

			db.lockRefusals++;
			return [{ pid: connection.pid, locked: false }];
		},

		unlockAll(connection)
		{
			if (db.lockOwner === connection)
			{
				db.lockOwner = null;
			}

			return [{}];
		},

		// A process dying closes its connections, which drops its session lock.
		kill(connection)
		{
			connection.dead = true;
			db.unlockAll(connection);
		},

		job(id)
		{
			return db.jobs.find((job) => job.id === id);
		},

		enqueue(id)
		{
			db.jobs.push({ id, state: "queued", progress: {}, triggered_by: ADMIN_ID, worker_id: null, last_error: null });
		},
	};

	db.journal = createFakeJournal({ orders: () => db.orders });

	function handle(text, values)
	{
		const journalResult = db.journal.handle(text, values);

		if (journalResult !== undefined)
		{
			return journalResult;
		}

		if (text.startsWith("INSERT INTO archive_workers"))
		{
			db.heartbeats++;
			db.workers.set(values[0], { version: values[1], heartbeatAt: Date.now() });
			return [];
		}

		if (text.startsWith("DELETE FROM archive_workers"))
		{
			return [];
		}

		if (text.startsWith("SELECT id FROM archive_jobs WHERE state = 'queued'"))
		{
			return db.jobs.filter((job) => job.state === "queued").slice(0, 1).map(({ id }) => ({ id }));
		}

		if (text.startsWith("UPDATE archive_jobs SET state = 'running'"))
		{
			const job = db.jobs.find((row) => row.state === "queued");

			if (!job)
			{
				return [];
			}

			Object.assign(job, { state: "running", worker_id: values[0], started_at: new Date(), heartbeat_at: new Date() });
			db.onClaim?.(job);

			return [{ ...job }];
		}

		if (text.startsWith("UPDATE archive_jobs SET progress"))
		{
			const [progress, id] = values;
			const job = db.job(id);

			if (job?.state !== "running")
			{
				return [];
			}

			job.progress = progress.json;
			db.progressWrites.push({ id, progress: progress.json });

			return [{ id }];
		}

		if (text.startsWith("UPDATE archive_jobs SET state = 'interrupted'"))
		{
			const running = db.jobs.filter((job) => job.state === "running");

			for (const job of running)
			{
				Object.assign(job, { state: "interrupted", finished_at: new Date(), last_error: values[0] });
			}

			return running.map(({ id }) => ({ id }));
		}

		if (text.startsWith("UPDATE archive_jobs SET state ="))
		{
			if (db.finishFailures > 0)
			{
				db.finishFailures--;
				throw new Error("connection reset");
			}

			const [state, progress, lastError, id] = values;
			const job = db.job(id);

			if (job?.state !== "running")
			{
				return [];
			}

			Object.assign(job, { state, progress: progress.json, last_error: lastError, finished_at: new Date() });

			return [{ id }];
		}

		if (text.startsWith("UPDATE archive_jobs SET heartbeat_at"))
		{
			return [];
		}

		if (text.includes("SELECT order_id, files"))
		{
			return db.orders.filter((order) => order.archived_at === null).map(({ order_id, files }) => ({ order_id, files }));
		}

		if (text.startsWith("UPDATE orders"))
		{
			const order = db.orders.find((row) => row.order_id === values[0] && row.archived_at === null);

			// markOrderArchived: never while a file of the order has a journal row.
			if (!order || order.files.some((fileId) => db.journal.rows.has(fileId)))
			{
				return [];
			}

			order.archived_at = new Date();

			return [{ order_id: order.order_id }];
		}

		if (text.includes("= ANY(files)"))
		{
			const [orderId, fileId] = values;

			return db.orders.some((order) => order.order_id === orderId && order.files?.includes(fileId)) ? [{}] : [];
		}

		throw new Error(`fake db: unexpected query ${text}`);
	}

	// A process's shared pool.
	db.client = () =>
	{
		const sql = (strings, ...values) =>
		{
			const text = strings.join("?").replace(/\s+/g, " ").trim();
			const gate = (text.startsWith("UPDATE archive_jobs SET progress") && db.progressGate) ||
				(text.startsWith("UPDATE archive_jobs SET state = 'running'") && db.claimGate);

			if (gate)
			{
				return gate.then(() => handle(text, values));
			}

			try
			{
				return Promise.resolve(handle(text, values));
			}
			catch (err)
			{
				return Promise.reject(err);
			}
		};

		sql.json = (value) => ({ json: value });

		return sql;
	};

	db.openLockClient = () =>
	{
		const connection = (strings) => connection.dead
			? Promise.reject(Object.assign(new Error("write CONNECTION_CLOSED"), { code: "CONNECTION_CLOSED" }))
			: connection.handler(strings.join("?"));

		connection.pid = db.nextPid++;
		connection.dead = false;
		connection.ended = false;
		connection.end = () =>
		{
			connection.ended = true;
			db.kill(connection);

			return Promise.resolve();
		};
		connection.handler = db.connectionHandler({ db, connection });
		db.connections.push(connection);

		return connection;
	};

	return db;
}

const noS3 = { send: () => Promise.reject(new Error("S3 is not used in this test")) };

function captureLog()
{
	const lines = [];
	const write = (level) => (message) =>
	{
		lines.push({ level, message });
	};

	return { lines, info: write("info"), warn: write("warn"), error: write("error") };
}

function makeWorker(db, options = {})
{
	const log = options.log ?? captureLog();
	const worker = createArchiveWorker({
		sql: options.sql ?? db.client(),
		openLockClient: options.openLockClient ?? db.openLockClient,
		s3: options.s3 ?? noS3,
		workerId: options.workerId ?? "worker-1",
		version: "test / projecto-compress 0.0.0",
		compress: options.compress ?? testCompressor,
		pollMs: options.pollMs ?? 5,
		flushMs: options.flushMs ?? 5,
		heartbeatMs: options.heartbeatMs ?? 5,
		dbTimeoutMs: options.dbTimeoutMs ?? 1000,
		log,
		...(options.recoverAtStartup ? { recoverAtStartup: options.recoverAtStartup } : {}),
		...(options.recoverAtJobStart ? { recoverAtJobStart: options.recoverAtJobStart } : {}),
	});

	return { worker, log };
}

// Rebuilds the counters from the worker's per-file log lines with
// recordFileResult, the way runArchiveJob counted them.
function countersFromFileLog(lines, jobId)
{
	const status = createStatus();
	const pattern = new RegExp(`^Job ${jobId}: order \\S+ file \\S+ (\\S+)(?: (\\d+) -> (\\d+) bytes)?$`);

	for (const { message } of lines)
	{
		const match = pattern.exec(message);

		if (match)
		{
			recordFileResult(status, {
				outcome: match[1],
				originalSize: match[2] === undefined ? null : Number(match[2]),
				storedSize: match[3] === undefined ? null : Number(match[3]),
				error: new Error("logged failure"),
			});
		}
	}

	return Object.fromEntries(COUNTER_KEYS.map((key) => [key, status[key]]));
}

const pickCounters = (progress) => Object.fromEntries(COUNTER_KEYS.map((key) => [key, progress[key]]));

// ---- job and lock (ported from order-archiver.test.mjs) ----

describe("job and lock", () =>
{
	test("a hung lock query fails the job instead of leaving it running", async () =>
	{
		const db = createFakeDb({ orders: [{ order_id: 7, files: [] }] });
		const { worker } = makeWorker(db, { dbTimeoutMs: 50 });

		await worker.tick();
		expect(worker.isStartupDone()).toBe(true);

		db.connectionHandler = lockHandler({ confirm: hang, unlock: hang });
		db.enqueue(1);
		await worker.tick();

		const job = db.job(1);

		expect(job.state).toBe("failed");
		expect(job.last_error).toMatch(/timed out/);
		expect(job.finished_at).toBeInstanceOf(Date);
		expect(job.progress.state).toBe("failed");

		// The unlock hung; closing the lock client ended its session, and the
		// lock with it.
		expect(db.connections.at(-1).ended).toBe(true);
		expect(db.lockOwner).toBe(null);

		// A new run can start right away.
		db.connectionHandler = lockHandler();
		db.enqueue(2);
		await worker.tick();

		expect(db.job(2).state).toBe("done");
		expect(db.job(2).progress.ordersArchived).toBe(1);
		expect(db.connections.at(-1).ended).toBe(true);
	});

	test("a reconnected lock session fails the job", async () =>
	{
		const db = createFakeDb({ orders: [{ order_id: 7, files: [] }] });
		const { worker } = makeWorker(db, { dbTimeoutMs: 50 });

		await worker.tick();
		db.connectionHandler = lockHandler({ confirm: async () => [{ pid: 4343, locked: true }] });
		db.enqueue(1);
		await worker.tick();

		expect(db.job(1).state).toBe("failed");
		expect(db.job(1).last_error).toMatch(/Lost the database session/);
		expect(db.connections.at(-1).ended).toBe(true);
	});

	test("a lock connection that cannot answer in time does not block later starts", async () =>
	{
		const db = createFakeDb({ orders: [{ order_id: 7, files: [] }] });
		let slow = false;
		let late = null;
		const openLockClient = () =>
		{
			const connection = db.openLockClient();

			if (slow)
			{
				const answer = connection.handler;

				late = connection;
				// The lock query arrives after the worker gave up; a closed
				// session can no longer take the lock.
				connection.handler = (text) => delay(100).then(() => (connection.dead
					? Promise.reject(new Error("write CONNECTION_CLOSED"))
					: answer(text)));
			}

			return connection;
		};
		const { worker, log } = makeWorker(db, { openLockClient, dbTimeoutMs: 20 });

		await worker.tick();
		db.enqueue(1);
		slow = true;
		await worker.tick();

		expect(db.job(1).state).toBe("queued");
		expect(log.lines.some(({ level, message }) => level === "warn" && /timed out/.test(message))).toBe(true);
		expect(late.ended).toBe(true);

		await delay(120);
		expect(db.lockOwner).toBe(null);

		slow = false;
		await worker.tick();

		expect(db.job(1).state).toBe("done");
		expect(db.lockOwner).toBe(null);
	});

	test("a checksum mismatch fails the file and its order instead of archiving it", async () =>
	{
		const data = compressibleData();

		await withS3(async (s3, { objects, counters }) =>
		{
			objects.set(FILE_A, { body: data, contentType: "model/stl", metadata: { sha256: sha("something else") } });

			const db = createFakeDb({ jobs: [{ id: 1, state: "queued" }], orders: [{ order_id: 7, files: [FILE_A] }] });
			const { worker } = makeWorker(db, { s3 });

			await worker.tick();
			await worker.tick();

			const job = db.job(1);

			expect(job.state).toBe("done");
			expect(job.progress.filesFailed).toBe(1);
			expect(job.progress.filesCompressed).toBe(0);
			expect(job.progress.ordersFailed).toBe(1);
			expect(job.progress.ordersArchived).toBe(0);
			expect(job.progress.ordersDone).toBe(0);
			expect(job.last_error).toMatch(new RegExp(`^File ${FILE_A}: Checksum mismatch`));
			expect(objects.get(FILE_A).body.equals(data)).toBe(true);
			expect(counters.put).toBe(0);
			expect(db.connections.every((connection) => connection.ended)).toBe(true);
		});
	});
});

// ---- the main loop, end to end ----

describe("main loop", () =>
{
	test("processes a queued job end to end", async () =>
	{
		const files = { [FILE_A]: compressibleData(1), [FILE_B]: compressibleData(2), [FILE_C]: randomBytes(32 * 1024) };

		await withS3(async (s3, { objects }) =>
		{
			for (const [fileId, body] of Object.entries(files))
			{
				seedFile(objects, fileId, body);
			}

			const db = createFakeDb({
				jobs: [{ id: 1, state: "queued" }],
				orders: [
					{ order_id: "o1", files: [FILE_A, FILE_B] },
					{ order_id: "o2", files: [FILE_C] },
					{ order_id: "o3", files: ["not-a-uuid"] },
				],
			});
			const { worker, log } = makeWorker(db, { s3 });
			const running = worker.run();

			await waitFor(() => ["done", "failed", "interrupted"].includes(db.job(1).state), "the job to finish");
			await worker.stop();
			await running;

			const job = db.job(1);

			expect(job.state).toBe("done");
			expect(job.worker_id).toBe("worker-1");
			expect(job.last_error).toBe("Order o3 has a file id that is not a UUID");
			expect(pickCounters(job.progress)).toEqual({
				ordersTotal: 3,
				ordersDone: 2,
				ordersFailed: 1,
				ordersArchived: 2,
				ordersChanged: 0,
				filesCompressed: 2,
				filesSkipped: 1,
				filesAlreadyArchived: 0,
				filesIncompressible: 1,
				filesOrphaned: 0,
				filesChanged: 0,
				filesFailed: 1,
				bytesBefore: files[FILE_A].length + files[FILE_B].length + files[FILE_C].length,
				bytesAfter: objects.get(FILE_A).body.length + objects.get(FILE_B).body.length + files[FILE_C].length,
			});
			expect(job.progress.currentFile).toBe(null);

			// The status in the database matches what recordFileResult counts
			// for the file results the worker reported, one log line per file.
			expect(pickCounters(job.progress)).toEqual({
				...countersFromFileLog(log.lines, 1),
				// Order counters are not per file.
				ordersTotal: 3,
				ordersDone: 2,
				ordersFailed: 1,
				ordersArchived: 2,
				ordersChanged: 0,
			});
			expect(log.lines.filter(({ message }) => message.startsWith("Job 1: order"))).toHaveLength(4);
			expect(log.lines.filter(({ message }) => message.startsWith("Job 1 done:"))).toHaveLength(1);
			// Ids only: no file name reaches a log line.
			expect(log.lines.some(({ message }) => /Skan|g%C3%B3rny/.test(message))).toBe(false);

			// Every file result forced a flush while the job was running.
			expect(db.progressWrites.length).toBeGreaterThanOrEqual(1);
			expect(db.progressWrites.every(({ progress }) => !JSON.stringify(progress).includes("Skan"))).toBe(true);

			for (const fileId of [FILE_A, FILE_B])
			{
				expect(objects.get(fileId).metadata.compression).toBe("zstd");
				expect(objects.get(fileId).metadata.encoder).toBe(TEST_ENCODER);
			}

			expect(objects.get(FILE_C).metadata.compression).toBe("identity");
			expect(db.orders.map((order) => order.archived_at !== null)).toEqual([true, true, false]);
			expect(db.workers.get("worker-1").version).toBe("test / projecto-compress 0.0.0");
			expect(db.lockOwner).toBe(null);
			expect(db.connections.every((connection) => connection.ended)).toBe(true);
			expect(await archiverTempFiles()).toEqual([]);
			// Each replaced file opened a journal row and closed it again.
			expect(db.journal.rows.size).toBe(0);
			expect(db.journal.log.filter((kind) => kind === "insert")).toHaveLength(2);
		});
	});

	test("startup marks running jobs interrupted only while holding the lock", async () =>
	{
		const db = createFakeDb({ jobs: [{ id: 1, state: "running", worker_id: "dead-worker" }] });
		const other = db.openLockClient();
		const lockHeldDuringRecovery = [];
		const { worker } = makeWorker(db, {
			recoverAtStartup: async () =>
			{
				lockHeldDuringRecovery.push(db.lockOwner !== null);
			},
		});

		// Another session holds the lock: nothing is touched, nothing is polled.
		db.tryLock(other);
		db.enqueue(2);
		await worker.tick();

		expect(worker.isStartupDone()).toBe(false);
		expect(db.job(1).state).toBe("running");
		expect(db.job(2).state).toBe("queued");
		expect(db.workers.has("worker-1")).toBe(true);
		expect(lockHeldDuringRecovery).toEqual([]);

		// Once the lock is free, the next tick finishes startup.
		db.unlockAll(other);
		db.jobs.pop();
		await worker.tick();

		expect(worker.isStartupDone()).toBe(true);
		expect(db.job(1).state).toBe("interrupted");
		expect(db.job(1).last_error).toBe(INTERRUPTED_ERROR);
		expect(lockHeldDuringRecovery).toEqual([true]);
		expect(db.lockOwner).toBe(null);
	});

	test("killing the worker mid-job leaves the job running, and the next start marks it interrupted", async () =>
	{
		const data = compressibleData();

		await withS3(async (s3, { objects }) =>
		{
			seedFile(objects, FILE_A, data);

			const db = createFakeDb({ orders: [{ order_id: "o1", files: [FILE_A] }] });
			let compressStarted = false;
			let crash;
			// Ignores the abort signal: a killed process runs no more code.
			const compress = () => new Promise((resolve, reject) =>
			{
				compressStarted = true;
				crash = reject;
			});
			const first = makeWorker(db, { s3, compress, workerId: "worker-1" });

			await first.worker.tick();
			db.enqueue(1);

			const ticking = first.worker.tick();

			await waitFor(() => compressStarted, "the compressor to start");

			// SIGKILL: the process and its database connections are gone.
			db.kill(db.lockOwner);

			expect(db.job(1).state).toBe("running");
			expect(db.job(1).worker_id).toBe("worker-1");

			const second = makeWorker(db, { s3, workerId: "worker-2" });

			await second.worker.tick();

			expect(db.job(1).state).toBe("interrupted");
			expect(db.job(1).last_error).toBe(INTERRUPTED_ERROR);
			expect(objects.get(FILE_A).body.equals(data)).toBe(true);

			// Clean up the simulated dead worker: its late write cannot revive the job.
			crash(new Error("killed"));
			await ticking;

			expect(db.job(1).state).toBe("interrupted");
			expect(db.orders[0].archived_at).toBe(null);
		});
	});

	test("SIGTERM aborts the compressor, ends the job as interrupted, releases the lock and returns", async () =>
	{
		const data = compressibleData();

		await withS3(async (s3, { objects, counters }) =>
		{
			seedFile(objects, FILE_A, data);
			seedFile(objects, FILE_B, compressibleData(2));

			const db = createFakeDb({
				jobs: [{ id: 1, state: "queued" }],
				orders: [{ order_id: "o1", files: [FILE_A] }, { order_id: "o2", files: [FILE_B] }],
			});
			let compressStarted = false;
			const compress = (srcPath, { signal }) => new Promise((resolve, reject) =>
			{
				compressStarted = true;
				signal.addEventListener("abort", () => reject(signal.reason), { once: true });
			});
			const { worker } = makeWorker(db, { s3, compress });
			const running = worker.run();

			await waitFor(() => compressStarted, "the compressor to start");
			await worker.stop();
			await running;

			const job = db.job(1);

			expect(job.state).toBe("interrupted");
			expect(job.last_error).toBe(INTERRUPTED_ERROR);
			// The aborted file is not done, but it did not fail either.
			expect(job.progress.filesFailed).toBe(0);
			expect(job.progress.lastError).toBe(null);
			expect(job.progress.ordersTotal).toBe(2);
			expect(job.progress.ordersDone).toBe(0);
			expect(job.progress.ordersFailed).toBe(0);
			expect(counters.put).toBe(0);
			expect(objects.get(FILE_A).body.equals(data)).toBe(true);
			expect(objects.get(FILE_B).metadata.compression).toBe(undefined);
			expect(db.lockOwner).toBe(null);
			expect(db.connections.every((connection) => connection.ended)).toBe(true);
			expect(await archiverTempFiles()).toEqual([]);
		});
	});

	test("a stop during upload lets the file finish and stops before the next one", async () =>
	{
		await withS3(async (s3, { objects }) =>
		{
			seedFile(objects, FILE_A, compressibleData(1));
			seedFile(objects, FILE_B, compressibleData(2));

			const db = createFakeDb({ jobs: [{ id: 1, state: "queued" }], orders: [{ order_id: "o1", files: [FILE_A, FILE_B] }] });
			let stopping = null;
			const holder = {};
			const compress = async (srcPath, options) =>
			{
				const result = await testCompressor(srcPath, options);

				// SIGTERM arrives once the compressor is done: upload and read-back still run.
				stopping = holder.worker.stop();

				return result;
			};

			holder.worker = makeWorker(db, { s3, compress }).worker;

			const running = holder.worker.run();

			await waitFor(() => stopping !== null, "the stop");
			await stopping;
			await running;

			expect(db.job(1).state).toBe("interrupted");
			expect(db.job(1).progress.filesCompressed).toBe(1);
			expect(objects.get(FILE_A).metadata.compression).toBe("zstd");
			expect(objects.get(FILE_B).metadata.compression).toBe(undefined);
			// The order was cut short, so it is neither counted nor marked.
			expect(db.job(1).progress.ordersDone).toBe(0);
			expect(db.orders[0].archived_at).toBe(null);
		});
	});

	test("two workers never run a job at the same time", async () =>
	{
		const fileIds = [FILE_A, FILE_B, FILE_C];

		await withS3(async (s3, { objects }) =>
		{
			fileIds.forEach((fileId, index) => seedFile(objects, fileId, compressibleData(index)));

			// Two queued jobs at once (the unique index would refuse this), so
			// only the advisory lock keeps the workers apart.
			const db = createFakeDb({
				jobs: [{ id: 1, state: "queued" }, { id: 2, state: "queued" }],
				orders: [{ order_id: "o1", files: fileIds }],
			});
			let active = 0;
			let maxActive = 0;
			const compress = async (srcPath, options) =>
			{
				active++;
				maxActive = Math.max(maxActive, active);

				try
				{
					await delay(30);

					return await testCompressor(srcPath, options);
				}
				finally
				{
					active--;
				}
			};
			const first = makeWorker(db, { s3, compress, workerId: "worker-1" });
			const second = makeWorker(db, { s3, compress, workerId: "worker-2" });
			const runs = [first.worker.run(), second.worker.run()];

			await waitFor(() => db.jobs.every((job) => job.state === "done"), "both jobs to finish", 10_000);
			await Promise.all([first.worker.stop(), second.worker.stop()]);
			await Promise.all(runs);

			expect(maxActive).toBe(1);
			expect(db.lockRefusals).toBeGreaterThan(0);
			expect(db.jobs.map((job) => job.worker_id).every((id) => id === "worker-1" || id === "worker-2")).toBe(true);
			// The second job found everything archived by the first.
			expect(db.job(1).progress.filesCompressed).toBe(3);
			expect(db.job(2).progress.ordersTotal).toBe(0);
			expect(db.lockOwner).toBe(null);
		});
	});
});

// ---- failure paths (review fixes) ----

describe("failure paths", () =>
{
	test("the heartbeat fires while running and stops with the worker", async () =>
	{
		const db = createFakeDb();
		const { worker } = makeWorker(db, { heartbeatMs: 5, pollMs: 1000 });
		const running = worker.run();

		// One registration, then timer heartbeats.
		await waitFor(() => db.heartbeats >= 3, "heartbeats");
		await worker.stop();
		await running;

		const count = db.heartbeats;

		await delay(40);
		expect(db.heartbeats).toBe(count);
	});

	test("finishJob is retried, and a job whose state cannot be stored is marked interrupted by the next startup", async () =>
	{
		const db = createFakeDb({ orders: [{ order_id: 7, files: [] }] });
		const { worker, log } = makeWorker(db);

		await worker.tick();

		// Two failures, then success: stored on the third attempt.
		db.finishFailures = 2;
		db.enqueue(1);
		await worker.tick();

		expect(db.job(1).state).toBe("done");
		expect(worker.isStartupDone()).toBe(true);

		// Every attempt fails: the lock is still released, and startup runs again.
		db.orders.push({ order_id: 8, files: [], archived_at: null });
		db.finishFailures = 3;
		db.enqueue(2);
		await worker.tick();

		expect(db.job(2).state).toBe("running");
		expect(db.lockOwner).toBe(null);
		expect(worker.isStartupDone()).toBe(false);
		expect(log.lines.filter(({ level, message }) => level === "error" && message.startsWith("Job 2:"))).toHaveLength(3);

		await worker.tick();

		expect(db.job(2).state).toBe("interrupted");
		expect(worker.isStartupDone()).toBe(true);
	});

	test("finishJob on a job that is no longer running is logged", async () =>
	{
		const db = createFakeDb({ orders: [{ order_id: 7, files: [] }] });
		const { worker, log } = makeWorker(db);

		await worker.tick();
		db.onClaim = (job) =>
		{
			// Someone else ends the row while this worker runs it.
			queueMicrotask(() =>
			{
				job.state = "interrupted";
			});
		};
		db.enqueue(1);
		await worker.tick();

		expect(db.job(1).state).toBe("interrupted");
		expect(log.lines.some(({ level, message }) => level === "warn" && /Job 1: was no longer running/.test(message))).toBe(true);
		expect(worker.isStartupDone()).toBe(true);
	});

	test("a claim that times out releases the lock, and a late claim is marked interrupted", async () =>
	{
		const db = createFakeDb({ orders: [{ order_id: 7, files: [] }] });
		const { worker, log } = makeWorker(db, { dbTimeoutMs: 30 });
		let land;

		await worker.tick();
		db.claimGate = new Promise((resolve) =>
		{
			land = resolve;
		});
		db.enqueue(1);
		await worker.tick();

		expect(log.lines.some(({ level, message }) => level === "warn" && /Claiming a queued job timed out/.test(message))).toBe(true);
		expect(db.lockOwner).toBe(null);
		expect(worker.isStartupDone()).toBe(false);

		// The startup on the next tick finds nothing running yet.
		db.claimGate = null;
		db.jobs[0].state = "held";
		await worker.tick();
		db.jobs[0].state = "queued";

		// Now the timed-out claim lands: a running job nobody runs.
		land();
		await waitFor(() => db.job(1).state === "running", "the late claim");
		expect(worker.isStartupDone()).toBe(false);

		await worker.tick();
		expect(db.job(1).state).toBe("interrupted");
		expect(db.job(1).last_error).toBe(INTERRUPTED_ERROR);
	});

	test("a progress write that lands after the finish cannot change the job, and writes never overtake each other", async () =>
	{
		await withS3(async (s3, { objects }) =>
		{
			seedFile(objects, FILE_A, compressibleData());

			const db = createFakeDb({ orders: [{ order_id: "o1", files: [FILE_A] }] });
			const { worker } = makeWorker(db, { s3, dbTimeoutMs: 30, flushMs: 5 });
			let land;

			await worker.tick();
			db.progressGate = new Promise((resolve) =>
			{
				land = resolve;
			});
			db.enqueue(1);
			await worker.tick();

			const job = db.job(1);
			const finalProgress = structuredClone(job.progress);

			expect(job.state).toBe("done");
			expect(job.progress.filesCompressed).toBe(1);
			expect(db.progressWrites).toHaveLength(0);

			// The held write lands now, with a snapshot older than the final one.
			land();
			await delay(20);

			expect(job.state).toBe("done");
			expect(job.progress).toEqual(finalProgress);
			expect(db.progressWrites).toHaveLength(0);
		});
	});

	test("a stop between the claim and the job start interrupts the job before any file", async () =>
	{
		await withS3(async (s3, { objects, counters }) =>
		{
			seedFile(objects, FILE_A, compressibleData());

			const db = createFakeDb({ orders: [{ order_id: "o1", files: [FILE_A] }] });
			const { worker } = makeWorker(db, { s3 });
			let stopped = null;

			await worker.tick();
			db.onClaim = () =>
			{
				stopped = worker.stop();
			};
			db.enqueue(1);
			await worker.tick();
			await stopped;

			expect(db.job(1).state).toBe("interrupted");
			expect(db.job(1).progress.ordersDone).toBe(0);
			expect(counters.put).toBe(0);
			expect(objects.get(FILE_A).metadata.compression).toBe(undefined);
			expect(db.lockOwner).toBe(null);
		});
	});

	test("a stop that arrives after the last file still reports done", async () =>
	{
		await withS3(async (s3, { objects }) =>
		{
			seedFile(objects, FILE_A, compressibleData());

			const db = createFakeDb({ orders: [{ order_id: "o1", files: [FILE_A] }] });
			const holder = {};
			const compress = async (srcPath, options) =>
			{
				const result = await testCompressor(srcPath, options);

				holder.stopped = holder.worker.stop();

				return result;
			};

			holder.worker = makeWorker(db, { s3, compress }).worker;
			await holder.worker.tick();
			db.enqueue(1);
			await holder.worker.tick();
			await holder.stopped;

			expect(db.job(1).state).toBe("done");
			expect(db.job(1).last_error).toBe(null);
			expect(db.orders[0].archived_at).not.toBe(null);
		});
	});

	test("releaseArchiveLock never throws or hangs, and always closes the lock client", async () =>
	{
		const ended = [];
		const deadClient = () => Promise.reject(new Error("write CONNECTION_CLOSED"));
		const hungClient = () => hang();

		deadClient.end = async () =>
		{
			ended.push("dead");
			throw new Error("already closed");
		};
		hungClient.end = () =>
		{
			ended.push("hung");
			return hang();
		};

		const started = Date.now();

		await releaseArchiveLock({ client: deadClient, pid: 1 }, 20);
		await releaseArchiveLock({ client: hungClient, pid: 2 }, 20);

		expect(ended).toEqual(["dead", "hung"]);
		expect(Date.now() - started).toBeLessThan(3000);
	});

	test("a lock session that died during the job is closed at release, and the pool keeps working", async () =>
	{
		await withS3(async (s3, { objects }) =>
		{
			seedFile(objects, FILE_A, compressibleData());

			const db = createFakeDb({ orders: [{ order_id: "o1", files: [FILE_A] }] });
			let resume;
			let compressStarted = false;
			const compress = async (srcPath, options) =>
			{
				compressStarted = true;
				await new Promise((resolve) =>
				{
					resume = resolve;
				});

				return testCompressor(srcPath, options);
			};
			const { worker, log } = makeWorker(db, { s3, compress });

			await worker.tick();
			db.enqueue(1);

			const ticking = worker.tick();

			await waitFor(() => compressStarted, "the compressor to start");

			// The lock connection drops: the server ends the session and its lock.
			const lockConnection = db.lockOwner;

			db.kill(lockConnection);
			resume();
			await ticking;

			expect(db.job(1).state).toBe("done");
			expect(lockConnection.ended).toBe(true);
			expect(log.lines.some(({ message }) => /unexpected query/.test(message))).toBe(false);

			// The shared pool still serves the next job.
			db.orders.push({ order_id: "o2", files: [], archived_at: null });
			db.enqueue(2);
			await worker.tick();

			expect(db.job(2).state).toBe("done");
			expect(db.lockOwner).toBe(null);
		});
	});

	test("no new job is claimed while a late claim leaves an orphaned running job", async () =>
	{
		const db = createFakeDb({ orders: [{ order_id: 7, files: [] }] });
		let land = null;
		const holder = {};
		const recoverAtStartup = async () =>
		{
			if (land)
			{
				// The timed-out claim lands while startup is running.
				db.claimGate = null;
				land();
				land = null;
				await waitFor(() => db.job(1).state === "running" && !holder.worker.isStartupDone(), "the late claim");
			}
		};

		holder.worker = makeWorker(db, { dbTimeoutMs: 30, recoverAtStartup }).worker;

		const { worker } = holder;

		await worker.tick();
		db.claimGate = new Promise((resolve) =>
		{
			land = resolve;
		});
		db.enqueue(1);
		await worker.tick();
		expect(worker.isStartupDone()).toBe(false);

		db.enqueue(2);
		await worker.tick();

		expect(db.job(1).state).toBe("running");
		expect(db.job(2).state).toBe("queued");
		expect(worker.isStartupDone()).toBe(false);

		await worker.tick();

		expect(db.job(1).state).toBe("interrupted");
		expect(db.job(2).state).toBe("done");
	});
});

// ---- main.js ----

describe("main.js", () =>
{
	test("refuses to start without the database and MinIO settings, and never prints their values", async () =>
	{
		const child = Bun.spawn([process.execPath, "--conditions", "react-server", "worker/archiver/main.js"], {
			cwd: path.join(import.meta.dir, ".."),
			env: { PATH: process.env.PATH ?? "", DB_URL: "postgres://user:secret-password@db/x", MINIO_ENDPOINT: "http://minio:9000" },
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		const output = stdout + stderr;

		expect(exitCode).toBe(1);
		expect(output).toContain("Missing environment variable(s): MINIO_ACCESS_KEY, MINIO_SECRET_KEY");
		expect(output).not.toContain("secret-password");
		expect(output).not.toContain("minio:9000");
	});

	test.skipIf(process.platform === "win32").each(["exception", "rejection"])("an uncaught %s stops the worker and exits 1", async (kind) =>
	{
		const binPath = path.join(tempDir, "fake-compress");
		const preload = path.join(tempDir, "fatal.mjs");

		await writeFile(binPath, "#!/bin/sh\necho '{\"type\":\"version\",\"version\":\"1.0.0\",\"zstd\":\"1.5.7\",\"brotli\":\"1.1.0\"}'\n", { mode: 0o755 });
		await writeFile(preload, kind === "exception"
			? "setTimeout(() => { throw new Error(\"fatal test\"); }, 1500);\n"
			: "setTimeout(() => { Promise.reject(new Error(\"fatal test\")); }, 1500);\n");

		const child = Bun.spawn([process.execPath, "--conditions", "react-server", "--preload", preload, "worker/archiver/main.js"], {
			cwd: path.join(import.meta.dir, ".."),
			env: {
				PATH: process.env.PATH ?? "",
				TMPDIR: tempDir,
				DB_URL: "postgres://user:pw@127.0.0.1:1/x",
				MINIO_ENDPOINT: "http://127.0.0.1:1",
				MINIO_ACCESS_KEY: "a",
				MINIO_SECRET_KEY: "b",
				PROJECTO_COMPRESSOR_BIN: binPath,
			},
			stdout: "pipe",
			stderr: "pipe",
			timeout: 20_000,
		});
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		const output = stdout + stderr;

		expect(exitCode).toBe(1);
		expect(output).toContain(kind === "exception" ? "Uncaught exception; stopping the worker" : "Unhandled rejection; stopping the worker");
		expect(output).toContain("stopped after a fatal error");
	}, 30_000);
});

// ---- progress flusher ----

describe("progress flusher", () =>
{
	function manualTimer()
	{
		const timer = { callback: null, cleared: false };

		return {
			timer,
			setTimer: (callback) =>
			{
				timer.callback = callback;
				return timer;
			},
			clearTimer: () =>
			{
				timer.cleared = true;
			},
			tick: async (flusher) =>
			{
				timer.callback();
				await flusher.flush();
			},
		};
	}

	test("writes on a tick only when the progress changed, at most once per tick", async () =>
	{
		const status = createStatus({ state: "running" });
		const writes = [];
		const clock = manualTimer();
		const flusher = createProgressFlusher({
			read: () => status,
			write: async (progress) =>
			{
				writes.push(progress);
			},
			intervalMs: 2000,
			setTimer: clock.setTimer,
			clearTimer: clock.clearTimer,
		});

		flusher.start();
		await clock.tick(flusher);
		expect(writes).toHaveLength(1);

		await clock.tick(flusher);
		expect(writes).toHaveLength(1);

		// A burst of changes between two ticks is one write.
		for (let i = 0; i < 100; i++)
		{
			status.bytesBefore += 10;
			status.currentFile = { phase: "download", bytesDone: i, bytesTotal: 100 };
		}

		await clock.tick(flusher);
		expect(writes).toHaveLength(2);
		expect(writes[1].bytesBefore).toBe(1000);
		expect(writes[1].currentFile.bytesDone).toBe(99);

		// Writes are snapshots: later changes do not leak into them.
		status.filesCompressed = 5;
		expect(writes[1].filesCompressed).toBe(0);

		await flusher.stop();
		expect(clock.timer.cleared).toBe(true);
	});

	test("a forced flush writes at once, and writes never overlap", async () =>
	{
		const status = createStatus();
		const started = [];
		let finishFirst;
		const flusher = createProgressFlusher({
			read: () => status,
			write: (progress) =>
			{
				started.push(progress);

				return started.length === 1 ? new Promise((resolve) =>
				{
					finishFirst = resolve;
				}) : Promise.resolve();
			},
			intervalMs: 60_000,
		});

		const first = flusher.flush();

		// The progress is read when the write runs, so let the first one start.
		await delay(0);
		expect(started).toHaveLength(1);
		status.filesCompressed = 1;

		const second = flusher.flush();

		await delay(10);
		expect(started).toHaveLength(1);

		finishFirst();
		expect(await first).toBe(true);
		expect(await second).toBe(true);
		expect(started.map((progress) => progress.filesCompressed)).toEqual([0, 1]);
	});

	test("a failed write is retried on the next flush", async () =>
	{
		const status = createStatus();
		const errors = [];
		let fail = true;
		let writes = 0;
		const flusher = createProgressFlusher({
			read: () => status,
			write: async () =>
			{
				if (fail)
				{
					throw new Error("db down");
				}

				writes++;
			},
			intervalMs: 60_000,
			onError: (err) => errors.push(err.message),
		});

		expect(await flusher.flush()).toBe(false);
		fail = false;
		expect(await flusher.flush()).toBe(true);
		expect(await flusher.flush()).toBe(false);
		expect(writes).toBe(1);
		expect(errors).toEqual(["db down"]);
	});

	test("the worker flushes during a job on its own timer", async () =>
	{
		await withS3(async (s3, { objects }) =>
		{
			seedFile(objects, FILE_A, compressibleData());

			const db = createFakeDb({ orders: [{ order_id: "o1", files: [FILE_A] }] });
			let release;
			const compress = async (srcPath, options) =>
			{
				options.onProgress({ phase: "zstd", bytesDone: 7, bytesTotal: 9 });
				await new Promise((resolve) =>
				{
					release = resolve;
				});

				return testCompressor(srcPath, options);
			};
			const { worker } = makeWorker(db, { s3, compress, flushMs: 5 });

			await worker.tick();
			db.enqueue(1);

			const ticking = worker.tick();

			// Only the timer can write here: no file has finished yet.
			await waitFor(() => db.progressWrites.some(({ progress }) => progress.currentFile?.phase === "compress-zstd"), "a timer flush");

			const write = db.progressWrites.find(({ progress }) => progress.currentFile?.phase === "compress-zstd");

			expect(write.progress.currentFile).toEqual({ phase: "compress-zstd", bytesDone: 7, bytesTotal: 9 });

			// Unchanged progress is not written again.
			const count = db.progressWrites.length;

			await delay(40);
			expect(db.progressWrites.length).toBe(count);

			release();
			await ticking;
			expect(db.job(1).state).toBe("done");
		});
	});
});

// ---- small pieces ----

describe("worker queries and version", () =>
{
	function recordingSql(rows = [])
	{
		const queries = [];
		const sql = (strings, ...values) =>
		{
			queries.push({ text: strings.join("?").replace(/\s+/g, " ").trim(), values });

			return Promise.resolve(rows);
		};

		sql.queries = queries;

		return sql;
	}

	test("hasQueuedJob and deleteStaleWorkers", async () =>
	{
		expect(await hasQueuedJob({ sql: recordingSql([{ id: 3 }]) })).toBe(true);
		expect(await hasQueuedJob({ sql: recordingSql([]) })).toBe(false);

		const sql = recordingSql([{ worker_id: "old" }]);

		expect(await deleteStaleWorkers({ workerId: "me", sql })).toBe(1);
		expect(sql.queries[0].text).toContain("DELETE FROM archive_workers");
		expect(sql.queries[0].values).toEqual([24, "me"]);
		await expect(deleteStaleWorkers({ workerId: "", sql })).rejects.toThrow(TypeError);
	});

	test("readCompressorVersion parses the version line and refuses anything else", async () =>
	{
		const script = path.join(tempDir, "version.mjs");
		const run = async (line) =>
		{
			await writeFile(script, `process.stdout.write(${JSON.stringify(line)} + "\\n");`);

			return readCompressorVersion({ binPath: process.execPath, binArgs: [script] });
		};

		expect(await run(JSON.stringify({ type: "version", version: "1.0.0", zstd: "1.5.7", brotli: "1.1.0" })))
			.toBe("projecto-compress 1.0.0 zstd 1.5.7 brotli 1.1.0");
		await expect(run("not json")).rejects.toThrow(/did not print JSON/);
		await expect(run(JSON.stringify({ type: "version", version: "1.0.0; rm -rf", zstd: "1.5.7", brotli: "1.1.0" })))
			.rejects.toThrow(/unexpected line/);
		await expect(readCompressorVersion({ binPath: "relative/bin" })).rejects.toThrow(TypeError);
	});

	test("readCompressorVersion stops reading after 4 KiB and kills the process", async () =>
	{
		const script = path.join(tempDir, "chatty.mjs");

		// Prints 8 KiB, then would run forever.
		await writeFile(script, "process.stdout.write(\"x\".repeat(8192)); setInterval(() => {}, 1000);\n");

		const started = Date.now();

		await expect(readCompressorVersion({ binPath: process.execPath, binArgs: [script] })).rejects.toThrow(/printed too much/);
		expect(Date.now() - started).toBeLessThan(5000);
	});

	test("the worker refuses bad options", () =>
	{
		const sql = createFakeDb().client();
		const base = { sql, s3: noS3, workerId: "w", version: "v", compress: testCompressor };

		expect(() => createArchiveWorker(base)).not.toThrow();
		expect(() => createArchiveWorker({ ...base, compress: undefined })).toThrow(TypeError);
		expect(() => createArchiveWorker({ ...base, s3: {} })).toThrow(TypeError);
		expect(() => createArchiveWorker({ ...base, workerId: "" })).toThrow(TypeError);
		expect(() => createArchiveWorker({ ...base, pollMs: 0 })).toThrow(RangeError);
	});

	test("FILE_OUTCOMES used in the log pattern are single words", () =>
	{
		expect(Object.values(FILE_OUTCOMES).every((outcome) => /^\S+$/.test(outcome))).toBe(true);
	});
});

// ---- crash journal (phase4.md 9.3 / 9.4 through the worker's hooks) ----

describe("crash journal", () =>
{
	const md5Etag = (body) => `"${createHash("md5").update(body).digest("hex")}"`;

	// The state a worker killed between the upload and the read-back leaves:
	// our verified archive in S3, an 'uploaded' journal row, the original and
	// the compressed candidate in the temp directory.
	async function seedCrashedUpload(objects, db, fileId, { state = "uploaded" } = {})
	{
		const data = compressibleData(7);
		const archive = zlib.zstdCompressSync(data);
		const originalPath = path.join(tempDir, `projecto-archive-${fileId}`);

		await writeFile(originalPath, data);
		await writeFile(path.join(tempDir, `projecto-archive-${fileId}.zst`), archive);
		objects.set(fileId, {
			body: archive,
			contentType: "model/stl",
			metadata: {
				original_name: encodeURIComponent(FILE_NAME),
				sha256: sha(data),
				compression: "zstd",
				original_size: String(data.length),
				archived_at: "2026-11-19T10:00:00.000Z",
			},
		});
		db.journal.seed({
			file_id: fileId,
			state,
			method: "zstd",
			original_sha256: sha(data),
			original_size: data.length,
			stored_size: archive.length,
			pre_upload_etag: md5Etag(data),
			stored_etag: md5Etag(archive),
			original_path: originalPath,
			...(state === "needs_attention" ? { note: "Original saved to /work/recovery/x.orig" } : {}),
		});

		return { data, archive, originalPath };
	}

	async function runQueuedJob(db, worker, id)
	{
		db.enqueue(id);
		await worker.tick();
		expect(db.job(id).state).toBe("done");

		return db.job(id);
	}

	test("a row left by a crash is settled at startup, the temp files are swept, and the next job marks the order", async () =>
	{
		await withS3(async (s3, { objects, counters }) =>
		{
			const db = createFakeDb({
				jobs: [{ id: 1, state: "running", worker_id: "dead-worker" }],
				orders: [{ order_id: "o1", files: [FILE_A] }],
			});
			const { archive } = await seedCrashedUpload(objects, db, FILE_A);
			const stray = path.join(tempDir, "projecto-archive-unreferenced");

			await writeFile(stray, "left by a killed download");

			const { worker } = makeWorker(db, { s3 });

			await worker.tick();

			expect(db.job(1).state).toBe("interrupted");
			// The read-back passed: row and original gone, archive untouched.
			expect(db.journal.rows.size).toBe(0);
			expect(objects.get(FILE_A).body.equals(archive)).toBe(true);
			expect(counters.put).toBe(0);
			// The sweep removed the candidate and the unreferenced original.
			expect(await archiverTempFiles()).toEqual([]);

			const job = await runQueuedJob(db, worker, 2);

			expect(job.progress.filesAlreadyArchived).toBe(1);
			expect(job.progress.ordersArchived).toBe(1);
			expect(db.orders[0].archived_at).not.toBe(null);
		});
	});

	test("recovery at job start settles a row before the candidate loop, so the order is marked in the same job", async () =>
	{
		await withS3(async (s3, { objects }) =>
		{
			const db = createFakeDb({ orders: [{ order_id: "o1", files: [FILE_A] }] });
			const { worker } = makeWorker(db, { s3 });

			await worker.tick();
			expect(worker.isStartupDone()).toBe(true);

			// Appears after startup, so only the job-start recovery can settle it.
			await seedCrashedUpload(objects, db, FILE_A);

			const job = await runQueuedJob(db, worker, 1);

			expect(db.journal.rows.size).toBe(0);
			expect(job.progress.ordersArchived).toBe(1);
			expect(job.progress.ordersChanged).toBe(0);
			expect(db.orders[0].archived_at).not.toBe(null);
		});
	});

	test("a job whose recovery cannot read the journal fails before any file", async () =>
	{
		await withS3(async (s3, { objects, counters }) =>
		{
			seedFile(objects, FILE_A, compressibleData());

			const db = createFakeDb({ orders: [{ order_id: "o1", files: [FILE_A] }] });
			const { worker } = makeWorker(db, { s3 });

			await worker.tick();
			db.journal.failures.list = 1;
			db.enqueue(1);
			await worker.tick();

			expect(db.job(1).state).toBe("failed");
			expect(db.job(1).last_error).toMatch(/fake journal: list failed/);
			expect(counters.put).toBe(0);
			expect(db.orders[0].archived_at).toBe(null);
			expect(db.lockOwner).toBe(null);
		});
	});

	test("needs_attention rows survive restarts, keep their original, block the order and show in the status count", async () =>
	{
		await withS3(async (s3, { objects, counters, requests }) =>
		{
			const db = createFakeDb({ orders: [{ order_id: "o1", files: [FILE_A] }] });
			const { data, archive, originalPath } = await seedCrashedUpload(objects, db, FILE_A, { state: "needs_attention" });
			const before = { ...db.journal.rows.get(FILE_A) };

			// Two starts in a row (a restart): neither touches the row or S3.
			for (const workerId of ["worker-1", "worker-2"])
			{
				const { worker } = makeWorker(db, { s3, workerId });

				await worker.tick();
				expect(worker.isStartupDone()).toBe(true);
			}

			expect(requests).toHaveLength(0);
			expect(db.journal.rows.get(FILE_A)).toEqual(before);
			// The sweep kept the referenced original, and removed the candidate.
			expect(await archiverTempFiles()).toEqual([path.basename(originalPath)]);
			expect((await readFile(originalPath)).equals(data)).toBe(true);

			// A job sees the file as already archived, but never marks its order.
			const { worker } = makeWorker(db, { s3, workerId: "worker-3" });

			await worker.tick();

			const job = await runQueuedJob(db, worker, 1);

			expect(job.progress.ordersArchived).toBe(0);
			expect(job.progress.ordersChanged).toBe(1);
			expect(db.orders[0].archived_at).toBe(null);
			expect(db.journal.rows.get(FILE_A)).toEqual(before);
			expect(objects.get(FILE_A).body.equals(archive)).toBe(true);
			expect(counters.put + counters.delete).toBe(0);

			const statusSql = (strings, ...values) =>
				Promise.resolve(db.journal.handle(strings.join("?").replace(/\s+/g, " ").trim(), values) ?? []);
			const status = await getArchiveStatus({ sql: statusSql });

			expect(status.needsAttention).toBe(1);
		});
	});
});
