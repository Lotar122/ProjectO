// TLS options of createS3Client (MINIO_CA_FILE, MINIO_TLS_INSECURE) read back
// from the https agent of the real client. No network is used.
//
// Run with `bun test --conditions react-server` so `server-only` resolves.

import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const { createS3Client, resetInsecureWarningForTests } = await import("../src/app/server-functions/MinIO/createS3Client.js");

const ENV_KEYS = ["MINIO_ENDPOINT", "MINIO_ACCESS_KEY", "MINIO_SECRET_KEY", "MINIO_CA_FILE", "MINIO_TLS_INSECURE"];
const savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
const CA_PEM = "-----BEGIN CERTIFICATE-----\nVEVTVC1EQVRBLU5PVC1BLVJFQUwtQ0VSVA==\n-----END CERTIFICATE-----\n";

let tempDir;
let warnLines;
const realWarn = console.warn;

// The client is cached on globalThis, so each test starts without one.
function clearCachedClient()
{
	delete globalThis.__projectoS3;
	resetInsecureWarningForTests();
}

async function httpsAgentOf(client)
{
	const config = await client.config.requestHandler.configProvider;

	return config.httpsAgent;
}

beforeEach(async () =>
{
	tempDir ??= await mkdtemp(path.join(tmpdir(), "s3-tls-"));
	clearCachedClient();

	for (const key of ENV_KEYS)
	{
		delete process.env[key];
	}

	process.env.MINIO_ENDPOINT = "https://minio.example.test:9000";
	process.env.MINIO_ACCESS_KEY = "test-access";
	process.env.MINIO_SECRET_KEY = "test-secret";

	warnLines = [];
	console.warn = (...args) => warnLines.push(args.map(String).join(" "));
});

afterEach(() =>
{
	console.warn = realWarn;
	clearCachedClient();
});

afterAll(async () =>
{
	for (const key of ENV_KEYS)
	{
		if (savedEnv[key] === undefined)
		{
			delete process.env[key];
		}
		else
		{
			process.env[key] = savedEnv[key];
		}
	}

	if (tempDir)
	{
		await rm(tempDir, { recursive: true, force: true });
	}
});

describe("createS3Client TLS options", () =>
{
	test("an https endpoint verifies certificates against the system CA list by default", async () =>
	{
		const agent = await httpsAgentOf(await createS3Client());

		expect(agent.options.rejectUnauthorized).toBe(true);
		expect(agent.options.ca).toBeUndefined();
		expect(warnLines).toEqual([]);
	});

	test("empty and false-like MINIO_TLS_INSECURE values keep verification on", async () =>
	{
		for (const value of ["", "  ", "0", "false", "FALSE"])
		{
			clearCachedClient();
			process.env.MINIO_TLS_INSECURE = value;

			const agent = await httpsAgentOf(await createS3Client());

			expect(agent.options.rejectUnauthorized).toBe(true);
		}

		expect(warnLines).toEqual([]);
	});

	test("MINIO_CA_FILE replaces the CA list with the file contents and keeps verification on", async () =>
	{
		const caFile = path.join(tempDir, "ca.pem");

		await writeFile(caFile, CA_PEM);
		process.env.MINIO_CA_FILE = caFile;

		const agent = await httpsAgentOf(await createS3Client());

		expect(agent.options.rejectUnauthorized).toBe(true);
		expect(agent.options.ca).toBe(CA_PEM);
		expect(warnLines).toEqual([]);
	});

	test.each(["1", "true", "TRUE", " 1 "])("MINIO_TLS_INSECURE=%p turns verification off and warns", async (value) =>
	{
		process.env.MINIO_TLS_INSECURE = value;

		const agent = await httpsAgentOf(await createS3Client());

		expect(agent.options.rejectUnauthorized).toBe(false);
		expect(agent.options.ca).toBeUndefined();
		expect(warnLines).toHaveLength(1);
		expect(warnLines[0]).toContain("MINIO_TLS_INSECURE");
	});

	test("the insecure-mode warning is logged once per process, not for every client creation", async () =>
	{
		process.env.MINIO_TLS_INSECURE = "1";

		await createS3Client();
		delete globalThis.__projectoS3;
		await createS3Client();
		await createS3Client();

		expect(warnLines).toHaveLength(1);
	});

	test("setting both MINIO_CA_FILE and MINIO_TLS_INSECURE throws and caches no client", async () =>
	{
		const caFile = path.join(tempDir, "both.pem");

		await writeFile(caFile, CA_PEM);
		process.env.MINIO_CA_FILE = caFile;
		process.env.MINIO_TLS_INSECURE = "1";

		await expect(createS3Client()).rejects.toThrow(/either MINIO_CA_FILE or MINIO_TLS_INSECURE/);
		expect(globalThis.__projectoS3).toBeUndefined();
	});

	test("an unreadable MINIO_CA_FILE throws an error that names the file and keeps the cause", async () =>
	{
		const missing = path.join(tempDir, "does-not-exist.pem");

		process.env.MINIO_CA_FILE = missing;

		const error = await createS3Client().then(() => null, (err) => err);

		expect(error).toBeInstanceOf(Error);
		expect(error.message).toContain("Could not read MINIO_CA_FILE");
		expect(error.message).toContain(missing);
		expect(error.cause?.code).toBe("ENOENT");
		expect(globalThis.__projectoS3).toBeUndefined();
	});

	test("an invalid MINIO_TLS_INSECURE value throws a RangeError on https", async () =>
	{
		process.env.MINIO_TLS_INSECURE = "maybe";

		await expect(createS3Client()).rejects.toThrow(RangeError);
		await expect(createS3Client()).rejects.toThrow(/MINIO_TLS_INSECURE must be/);
	});

	test("an http endpoint ignores bad TLS values and never reads the CA file", async () =>
	{
		process.env.MINIO_ENDPOINT = "http://minio:9000";
		process.env.MINIO_TLS_INSECURE = "maybe";
		process.env.MINIO_CA_FILE = path.join(tempDir, "missing-for-http.pem");

		const agent = await httpsAgentOf(await createS3Client());

		expect(agent.options.rejectUnauthorized).toBeUndefined();
		expect(agent.options.ca).toBeUndefined();
		expect(warnLines).toEqual([]);
	});

	test("an http endpoint ignores both options set together", async () =>
	{
		process.env.MINIO_ENDPOINT = "http://minio:9000";
		process.env.MINIO_TLS_INSECURE = "1";
		process.env.MINIO_CA_FILE = path.join(tempDir, "unused.pem");

		await expect(createS3Client()).resolves.toBeDefined();
		expect(warnLines).toEqual([]);
	});

	test("the client is created once and reused", async () =>
	{
		const first = await createS3Client();
		const second = await createS3Client();

		expect(second).toBe(first);
	});
});
