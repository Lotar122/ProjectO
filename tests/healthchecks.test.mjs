// Docker health checks: worker/archiver/liveness.js (public exports), and
// worker/archiver/healthcheck.js and docker/web-healthcheck.js (spawned as
// the HEALTHCHECK commands run them). Synthetic files and a local HTTP server only.
//
// Run with `bun test --conditions react-server tests/healthchecks.test.mjs`.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
	LIVENESS_MAX_AGE_MS_DEFAULT,
	isLivenessFresh,
	touchLivenessFile,
} from "../worker/archiver/liveness.js";

const ROOT = path.join(import.meta.dir, "..");

let tempDir;
let counter = 0;

beforeAll(async () =>
{
	tempDir = await mkdtemp(path.join(tmpdir(), "healthchecks-"));
});

afterAll(async () =>
{
	await rm(tempDir, { recursive: true, force: true });
});

const newPath = () => path.join(tempDir, `alive-${++counter}`);

async function writeAged(filePath, ageMs)
{
	await writeFile(filePath, "x\n");

	const when = new Date(Date.now() - ageMs);

	await utimes(filePath, when, when);
}

// Spawns a script with a clean environment and returns its exit code and stderr.
async function run(script, env)
{
	const child = Bun.spawn([process.execPath, script], {
		cwd: ROOT,
		env: { PATH: process.env.PATH ?? "", ...env },
		stdout: "ignore",
		stderr: "pipe",
	});
	const [stderr, code] = await Promise.all([new Response(child.stderr).text(), child.exited]);

	return { code, stderr };
}

describe("liveness.js", () =>
{
	test("the default maximum age is 60 seconds", () =>
	{
		expect(LIVENESS_MAX_AGE_MS_DEFAULT).toBe(60_000);
	});

	test("touchLivenessFile writes an ISO timestamp and refreshes the mtime", async () =>
	{
		const filePath = newPath();

		await writeAged(filePath, 3_600_000);
		expect(await isLivenessFresh(filePath)).toBe(false);

		await touchLivenessFile(filePath);

		const text = await Bun.file(filePath).text();

		expect(text.endsWith("\n")).toBe(true);
		expect(new Date(text.trim()).toISOString()).toBe(text.trim());
		expect(await isLivenessFresh(filePath)).toBe(true);
	});

	test("touchLivenessFile rejects a missing path", async () =>
	{
		await expect(touchLivenessFile("")).rejects.toThrow(TypeError);
		await expect(touchLivenessFile(undefined)).rejects.toThrow(TypeError);
	});

	test("a missing file is not fresh", async () =>
	{
		expect(await isLivenessFresh(newPath())).toBe(false);
	});

	test("freshness is measured against maxAgeMs and the injected clock", async () =>
	{
		const filePath = newPath();

		await touchLivenessFile(filePath);

		const { lastModified } = Bun.file(filePath);

		expect(await isLivenessFresh(filePath, { maxAgeMs: 1000, now: lastModified + 1000 })).toBe(true);
		expect(await isLivenessFresh(filePath, { maxAgeMs: 1000, now: lastModified + 1001 })).toBe(false);
		expect(await isLivenessFresh(filePath, { maxAgeMs: 1000, now: lastModified - 5000 })).toBe(true);
	});

	test("uses the 60 second default when no maxAgeMs is given", async () =>
	{
		const fresh = newPath();
		const stale = newPath();

		await writeAged(fresh, 50_000);
		await writeAged(stale, 70_000);

		expect(await isLivenessFresh(fresh)).toBe(true);
		expect(await isLivenessFresh(stale)).toBe(false);
	});

	test("validates its arguments", async () =>
	{
		await expect(isLivenessFresh("")).rejects.toThrow(TypeError);
		await expect(isLivenessFresh(42)).rejects.toThrow(TypeError);

		for (const maxAgeMs of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])
		{
			await expect(isLivenessFresh(newPath(), { maxAgeMs })).rejects.toThrow(RangeError);
		}
	});
});

describe("worker/archiver/healthcheck.js", () =>
{
	const SCRIPT = "worker/archiver/healthcheck.js";

	test("exits 1 and says so when ARCHIVER_LIVENESS_FILE is not set", async () =>
	{
		const { code, stderr } = await run(SCRIPT, {});

		expect(code).toBe(1);
		expect(stderr).toContain("ARCHIVER_LIVENESS_FILE is not set");
	});

	test("exits 1 when the liveness file does not exist", async () =>
	{
		const { code, stderr } = await run(SCRIPT, { ARCHIVER_LIVENESS_FILE: newPath() });

		expect(code).toBe(1);
		expect(stderr).toContain("no heartbeat in the last 60000 ms");
	});

	test("exits 0 for a fresh file", async () =>
	{
		const filePath = newPath();

		await touchLivenessFile(filePath);

		expect((await run(SCRIPT, { ARCHIVER_LIVENESS_FILE: filePath })).code).toBe(0);
	});

	test("ARCHIVER_LIVENESS_MAX_AGE_MS moves the threshold in both directions", async () =>
	{
		const filePath = newPath();

		await writeAged(filePath, 30_000);

		expect((await run(SCRIPT, { ARCHIVER_LIVENESS_FILE: filePath })).code).toBe(0);

		const strict = await run(SCRIPT, { ARCHIVER_LIVENESS_FILE: filePath, ARCHIVER_LIVENESS_MAX_AGE_MS: "5000" });

		expect(strict.code).toBe(1);
		expect(strict.stderr).toContain("no heartbeat in the last 5000 ms");

		await writeAged(filePath, 120_000);
		expect((await run(SCRIPT, { ARCHIVER_LIVENESS_FILE: filePath, ARCHIVER_LIVENESS_MAX_AGE_MS: "300000" })).code).toBe(0);
	});

	test.each(["abc", "-5", "1.5"])("an invalid ARCHIVER_LIVENESS_MAX_AGE_MS (%p) is unhealthy, not ignored", async (maxAge) =>
	{
		const filePath = newPath();

		await touchLivenessFile(filePath);

		const { code, stderr } = await run(SCRIPT, { ARCHIVER_LIVENESS_FILE: filePath, ARCHIVER_LIVENESS_MAX_AGE_MS: maxAge });

		expect(code).toBe(1);
		expect(stderr).toContain("health check failed");
	});

	test("an empty ARCHIVER_LIVENESS_MAX_AGE_MS falls back to the default", async () =>
	{
		const filePath = newPath();

		await touchLivenessFile(filePath);

		expect((await run(SCRIPT, { ARCHIVER_LIVENESS_FILE: filePath, ARCHIVER_LIVENESS_MAX_AGE_MS: "" })).code).toBe(0);
	});
});

describe("docker/web-healthcheck.js", () =>
{
	const SCRIPT = "docker/web-healthcheck.js";
	let pingResponse;
	let server;

	beforeAll(() =>
	{
		pingResponse = () => new Response("{}", { status: 200 });
		server = Bun.serve({
			port: 0,
			hostname: "127.0.0.1",
			fetch: (request) => (new URL(request.url).pathname === "/api/ping"
				? pingResponse()
				: new Response("not found", { status: 404 })),
		});
	});

	afterAll(async () =>
	{
		await server.stop(true);
	});

	const check = (env = {}) => run(SCRIPT, { PORT: String(server.port), ...env });

	test("exits 0 when /api/ping answers 2xx and the archiver is not embedded", async () =>
	{
		pingResponse = () => new Response("{}", { status: 204 });

		expect((await check()).code).toBe(0);
	});

	test("a non-2xx answer is unhealthy and the message names the status", async () =>
	{
		pingResponse = () => new Response("down", { status: 503 });

		const { code, stderr } = await check();

		expect(code).toBe(1);
		expect(stderr).toContain("/api/ping answered 503");
	});

	test("a redirect is not followed and counts as unhealthy", async () =>
	{
		pingResponse = () => new Response(null, { status: 302, headers: { Location: "/login" } });

		const { code, stderr } = await check();

		expect(code).toBe(1);
		expect(stderr).toContain("302");
	});

	test("an unreachable web server is unhealthy", async () =>
	{
		const free = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
		const closedPort = free.port;

		await free.stop(true);

		const { code, stderr } = await run(SCRIPT, { PORT: String(closedPort) });

		expect(code).toBe(1);
		expect(stderr).toContain("health check failed");
	});

	test("embedded mode needs ARCHIVER_LIVENESS_FILE", async () =>
	{
		pingResponse = () => new Response("{}");

		const { code, stderr } = await check({ ARCHIVER_MODE: "embedded" });

		expect(code).toBe(1);
		expect(stderr).toContain("ARCHIVER_LIVENESS_FILE is not set");
	});

	test("embedded mode follows the worker heartbeat and ARCHIVER_LIVENESS_MAX_AGE_MS", async () =>
	{
		pingResponse = () => new Response("{}");

		const filePath = newPath();
		const env = { ARCHIVER_MODE: "embedded", ARCHIVER_LIVENESS_FILE: filePath };

		expect((await check(env)).code).toBe(1);

		await writeAged(filePath, 90_000);

		const stale = await check(env);

		expect(stale.code).toBe(1);
		expect(stale.stderr).toContain("no worker heartbeat in the last 60000 ms");
		expect((await check({ ...env, ARCHIVER_LIVENESS_MAX_AGE_MS: "120000" })).code).toBe(0);

		await touchLivenessFile(filePath);
		expect((await check(env)).code).toBe(0);
	});

	test("the worker heartbeat is ignored unless ARCHIVER_MODE is embedded", async () =>
	{
		pingResponse = () => new Response("{}");

		expect((await check({ ARCHIVER_MODE: "external", ARCHIVER_LIVENESS_FILE: newPath() })).code).toBe(0);
	});

	test("a healthy heartbeat does not hide a failing web check", async () =>
	{
		pingResponse = () => new Response("", { status: 500 });

		const filePath = newPath();

		await touchLivenessFile(filePath);

		expect((await check({ ARCHIVER_MODE: "embedded", ARCHIVER_LIVENESS_FILE: filePath })).code).toBe(1);
	});
});
