import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import {
	createArchiverSupervisor,
	startArchiverSupervisor,
	stop as stopGlobal,
} from "../src/app/server-functions/orders/archiverSupervisor.js";
import { stopOnParentGone } from "../worker/archiver/parentWatch.js";

const FAKE_CHILD = path.join(import.meta.dir, "fixtures", "fake-archiver-child.mjs");

const noop = () => undefined;
const silentLog = { debug: noop, info: noop, warn: noop, error: noop };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate, timeoutMs = 5000)
{
	const deadline = Date.now() + timeoutMs;

	while (Date.now() < deadline)
	{
		const value = await predicate();

		if (value)
		{
			return value;
		}

		await sleep(10);
	}

	throw new Error("waitFor timed out");
}

// Runs fn with a fresh log file and a factory for supervisors that run the fake child.
async function withSupervisor(scenario, options, fn)
{
	const dir = await mkdtemp(path.join(os.tmpdir(), "archiver-supervisor-test-"));
	const logFile = path.join(dir, "starts.log");
	const supervisor = createArchiverSupervisor({
		env: { ...process.env, FAKE_SCENARIO: scenario, FAKE_LOG: logFile },
		log: silentLog,
		command: process.execPath,
		args: [FAKE_CHILD],
		handleSignals: false,
		...options,
	});
	const starts = async () =>
	{
		try
		{
			return (await readFile(logFile, "utf8")).split("\n").filter(Boolean).map((line) => line.split(" "));
		}
		catch
		{
			return [];
		}
	};

	try
	{
		await fn(supervisor, starts);
	}
	finally
	{
		await supervisor.stop();
		await rm(dir, { recursive: true, force: true });
	}
}

const isAlive = (pid) =>
{
	try
	{
		process.kill(pid, 0);
		return true;
	}
	catch
	{
		return false;
	}
};

test("spawns the worker with ARCHIVER_SUPERVISED=1", async () =>
{
	await withSupervisor("run", {}, async (supervisor, starts) =>
	{
		supervisor.start();

		const [first] = await waitFor(async () => (await starts()).length > 0 && starts());

		assert.equal(first[1], "1");
		assert.equal(supervisor.running, true);
	});
});

test("builds the default command and arguments", () =>
{
	let call = null;
	const fakeChild = new PassThrough();

	fakeChild.stdin = new PassThrough();
	fakeChild.kill = () => true;

	const supervisor = createArchiverSupervisor({
		env: { ARCHIVER_BUN_BIN: "/opt/bun" },
		log: silentLog,
		cwd: "/srv/app",
		handleSignals: false,
		spawnFn: (command, args, options) =>
		{
			call = { command, args, options };
			return fakeChild;
		},
	});

	supervisor.start();

	assert.equal(call.command, process.versions.bun ? process.execPath : "/opt/bun");
	assert.deepEqual(call.args, ["--conditions", "react-server", "/srv/app/worker/archiver/main.js"]);
	assert.deepEqual(call.options.stdio, ["pipe", "inherit", "inherit"]);
	assert.equal(call.options.env.ARCHIVER_SUPERVISED, "1");
});

test("restarts with a doubling backoff after crashes", async () =>
{
	await withSupervisor("crash", { backoff: { initialMs: 60, maxMs: 240, resetAfterMs: 60_000 } }, async (supervisor, starts) =>
	{
		supervisor.start();

		const rows = await waitFor(async () =>
		{
			const current = await starts();

			return current.length >= 4 && current;
		});
		const gaps = rows.slice(1, 4).map((row, i) => Number(row[2]) - Number(rows[i][2]));

		// Child start-up time adds to each gap, so only the lower bounds are exact.
		assert.ok(gaps[0] >= 55, `first gap ${gaps[0]}`);
		assert.ok(gaps[1] >= 115, `second gap ${gaps[1]}`);
		assert.ok(gaps[2] >= 235, `third gap ${gaps[2]}`);
		assert.ok(gaps[2] > gaps[0], "backoff grows");
	});
});

test("restarts after a clean exit too, and resets the backoff after a long uptime", async () =>
{
	const delays = [];
	const realSetTimeout = globalThis.setTimeout;
	const children = [];
	const makeChild = () =>
	{
		const child = new PassThrough();

		child.stdin = new PassThrough();
		child.kill = () =>
		{
			queueMicrotask(() => child.emit("exit", 0, "SIGTERM"));
			return true;
		};
		children.push(child);
		return child;
	};

	// resetAfterMs of 1 ms: every run counts as a long uptime.
	const supervisor = createArchiverSupervisor({
		env: {},
		log: silentLog,
		handleSignals: false,
		backoff: { initialMs: 5, maxMs: 40, resetAfterMs: 1 },
		spawnFn: makeChild,
	});

	globalThis.setTimeout = (fn, ms, ...rest) =>
	{
		// Only the supervisor's restart timer (spawnChild) counts.
		if (fn.name === "spawnChild")
		{
			delays.push(ms);
		}

		return realSetTimeout(fn, ms, ...rest);
	};

	try
	{
		supervisor.start();
		await sleep(5);
		children[0].emit("exit", 0, null);
		await waitFor(() => children.length === 2);
		await sleep(5);
		children[1].emit("exit", 0, null);
		await waitFor(() => children.length === 3);
	}
	finally
	{
		globalThis.setTimeout = realSetTimeout;
		await supervisor.stop();
	}

	assert.deepEqual(delays.slice(0, 2), [5, 5]);
});

test("does not restart after stop()", async () =>
{
	await withSupervisor("run", { backoff: { initialMs: 30, maxMs: 60, resetAfterMs: 60_000 } }, async (supervisor, starts) =>
	{
		supervisor.start();
		await waitFor(async () => (await starts()).length === 1);

		const [[pid]] = await starts();

		await supervisor.stop();
		assert.equal(supervisor.running, false);
		await sleep(150);
		assert.equal((await starts()).length, 1);
		assert.equal(isAlive(Number(pid)), false);
	});
});

test("stop() during the restart delay cancels the restart", async () =>
{
	await withSupervisor("crash", { backoff: { initialMs: 100, maxMs: 100, resetAfterMs: 60_000 } }, async (supervisor, starts) =>
	{
		supervisor.start();
		await waitFor(async () => (await starts()).length === 1);
		await sleep(30);
		await supervisor.stop();
		await sleep(200);
		assert.equal((await starts()).length, 1);
	});
});

test("sends SIGKILL when the worker ignores SIGTERM past the grace period", async () =>
{
	await withSupervisor("ignore-term", { stopGraceMs: 300 }, async (supervisor, starts) =>
	{
		supervisor.start();

		const [[pid]] = await waitFor(async () => (await starts()).length > 0 && starts());

		// Give the child time to install its SIGTERM handler.
		await sleep(200);

		const begin = Date.now();

		await supervisor.stop();

		const took = Date.now() - begin;

		assert.ok(took >= 250, `stopped after ${took} ms, before the grace period`);
		assert.equal(isAlive(Number(pid)), false);
	});
});

test("a worker that exits on SIGTERM stops without waiting for the grace period", async () =>
{
	await withSupervisor("run", { stopGraceMs: 30_000 }, async (supervisor, starts) =>
	{
		supervisor.start();
		await waitFor(async () => (await starts()).length === 1);
		await sleep(200);

		const begin = Date.now();

		await supervisor.stop();
		assert.ok(Date.now() - begin < 5000);
	});
});

test("start and stop are idempotent", async () =>
{
	await withSupervisor("run", {}, async (supervisor, starts) =>
	{
		supervisor.start();
		supervisor.start();
		await waitFor(async () => (await starts()).length === 1);
		await sleep(100);
		assert.equal((await starts()).length, 1);
		assert.equal(await supervisor.stop(), await supervisor.stop());
	});
});

test("startArchiverSupervisor returns the same supervisor and spawns once", async () =>
{
	const children = [];
	const spawnFn = () =>
	{
		const child = new PassThrough();

		child.stdin = new PassThrough();
		child.kill = () =>
		{
			queueMicrotask(() => child.emit("exit", 0, "SIGTERM"));
			return true;
		};
		children.push(child);
		return child;
	};
	const options = { env: {}, log: silentLog, spawnFn, handleSignals: false };

	delete globalThis.__projectoArchiverSupervisor;

	try
	{
		const first = startArchiverSupervisor(options);
		const second = startArchiverSupervisor(options);

		assert.equal(first, second);
		assert.equal(children.length, 1);
		await stopGlobal();
	}
	finally
	{
		delete globalThis.__projectoArchiverSupervisor;
	}
});

test("rejects an invalid ARCHIVER_STOP_GRACE_MS", () =>
{
	assert.throws(() => createArchiverSupervisor({ env: { ARCHIVER_STOP_GRACE_MS: "abc" }, log: silentLog }), RangeError);
	assert.throws(() => createArchiverSupervisor({ env: { ARCHIVER_STOP_GRACE_MS: "0" }, log: silentLog }), RangeError);
});

test("stopOnParentGone calls back once when the stream ends", async () =>
{
	const stream = new PassThrough();
	let calls = 0;

	stopOnParentGone(stream, () => calls++);
	stream.end();
	await sleep(20);
	assert.equal(calls, 1);
	assert.throws(() => stopOnParentGone(stream, null), TypeError);
});

test("a child with a stdin watcher exits when its parent closes the pipe", async () =>
{
	const child = spawn(process.execPath, [FAKE_CHILD], {
		stdio: ["pipe", "inherit", "inherit"],
		env: { ...process.env, FAKE_SCENARIO: "watch-stdin" },
	});
	const exited = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));

	await sleep(200);
	assert.equal(child.exitCode, null);
	child.stdin.end();

	const result = await Promise.race([exited, sleep(5000).then(() => "timeout")]);

	if (result === "timeout")
	{
		child.kill("SIGKILL");
	}

	assert.deepEqual(result, { code: 0, signal: null });
});
