import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import path from "node:path";
import { PassThrough } from "node:stream";

// Run with `bun test --conditions react-server` so `server-only` resolves.
const ENV_KEYS = [
	"NODE_ENV",
	"NEXT_PHASE",
	"KRATOS_PUBLIC_INTERNAL_URL",
	"KRATOS_ADMIN_URL",
	"NEXT_PUBLIC_KRATOS_PUBLIC_URL",
	"DB_URL",
];

let counter = 0;

// Imports a fresh copy of the module under the given env.
async function importWithEnv(path, env)
{
	const saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

	for (const key of ENV_KEYS)
	{
		delete process.env[key];
	}
	Object.assign(process.env, env);

	try
	{
		counter += 1;
		return await import(`${path}?case=${counter}`);
	}
	finally
	{
		for (const key of ENV_KEYS)
		{
			if (saved[key] === undefined)
			{
				delete process.env[key];
			}
			else
			{
				process.env[key] = saved[key];
			}
		}
	}
}

const KRATOS_SERVER = "../src/app/lib/kratosServer.js";
const KRATOS = "../src/app/lib/kratos.js";
const DB = "../src/app/lib/db.js";
const INSTRUMENTATION = "../src/instrumentation-node.js";

test("kratosServer uses docker defaults outside production", async () =>
{
	const mod = await importWithEnv(KRATOS_SERVER, { NODE_ENV: "development" });

	assert.equal(mod.KRATOS_PUBLIC_INTERNAL_URL, "http://kratos:4433");
	assert.equal(mod.KRATOS_ADMIN_URL, "http://kratos:4434");
});

test("kratosServer has no defaults in production", async () =>
{
	const mod = await importWithEnv(KRATOS_SERVER, { NODE_ENV: "production" });

	assert.equal(mod.KRATOS_PUBLIC_INTERNAL_URL, undefined);
	assert.equal(mod.KRATOS_ADMIN_URL, undefined);
});

test("kratosServer strips trailing slashes", async () =>
{
	const mod = await importWithEnv(KRATOS_SERVER, {
		NODE_ENV: "production",
		KRATOS_PUBLIC_INTERNAL_URL: "http://public.example:1//",
		KRATOS_ADMIN_URL: "http://admin.example:2/",
	});

	assert.equal(mod.KRATOS_PUBLIC_INTERNAL_URL, "http://public.example:1");
	assert.equal(mod.KRATOS_ADMIN_URL, "http://admin.example:2");
});

test("kratosServer prefers the environment in every mode", async () =>
{
	for (const NODE_ENV of ["development", "production"])
	{
		const mod = await importWithEnv(KRATOS_SERVER, {
			NODE_ENV,
			KRATOS_PUBLIC_INTERNAL_URL: "http://public.example:1",
			KRATOS_ADMIN_URL: "http://admin.example:2",
		});

		assert.equal(mod.KRATOS_PUBLIC_INTERNAL_URL, "http://public.example:1");
		assert.equal(mod.KRATOS_ADMIN_URL, "http://admin.example:2");
	}
});

test("kratos.js throws at startup in production without the public URL", async () =>
{
	await assert.rejects(
		importWithEnv(KRATOS, { NODE_ENV: "production" }),
		/NEXT_PUBLIC_KRATOS_PUBLIC_URL is not set/,
	);
});

test("kratos.js does not throw during the production build", async () =>
{
	const originalWarn = console.warn;
	const warnings = [];
	console.warn = (...args) => warnings.push(args.join(" "));

	try
	{
		const mod = await importWithEnv(KRATOS, {
			NODE_ENV: "production",
			NEXT_PHASE: "phase-production-build",
		});

		assert.equal(mod.KRATOS_PUBLIC, "");
		assert.equal(warnings.length, 1);
	}
	finally
	{
		console.warn = originalWarn;
	}
});

test("kratos.js reads the public URL when it is set", async () =>
{
	const mod = await importWithEnv(KRATOS, {
		NODE_ENV: "production",
		NEXT_PUBLIC_KRATOS_PUBLIC_URL: "https://auth.example/kratos",
	});

	assert.equal(mod.KRATOS_PUBLIC, "https://auth.example/kratos");
});

test("db.js throws in production without DB_URL", async () =>
{
	await assert.rejects(
		importWithEnv(DB, { NODE_ENV: "production" }),
		/DB_URL is not set/,
	);
});

test("db.js does not throw during the production build", async () =>
{
	delete globalThis.__projectoDb;

	try
	{
		const mod = await importWithEnv(DB, {
			NODE_ENV: "production",
			NEXT_PHASE: "phase-production-build",
		});

		assert.ok(mod.DB);
	}
	finally
	{
		await globalThis.__projectoDb?.end({ timeout: 0 });
		delete globalThis.__projectoDb;
	}
});

test("db.js does not throw in production when DB_URL is set", async () =>
{
	delete globalThis.__projectoDb;

	try
	{
		const mod = await importWithEnv(DB, {
			NODE_ENV: "production",
			DB_URL: "postgres://user:pass@127.0.0.1:1/db",
		});

		assert.ok(mod.DB);
	}
	finally
	{
		await globalThis.__projectoDb?.end({ timeout: 0 });
		delete globalThis.__projectoDb;
	}
});

// Runs registerNode() with process.exit and the console stubbed; returns the
// exit codes it requested and the lines it logged.
async function runRegisterNode(env, options)
{
	const mod = await importWithEnv(INSTRUMENTATION, {});
	const savedEnv = Object.fromEntries(
		[...ENV_KEYS, "MINIO_ENDPOINT", "MINIO_ACCESS_KEY", "MINIO_SECRET_KEY", "ARCHIVER_MODE", "PROJECTO_COMPRESSOR_BIN"].map((key) => [key, process.env[key]]),
	);
	const savedConsole = {};
	const savedExit = process.exit;
	const exits = [];
	const lines = [];

	for (const method of ["log", "info", "warn", "error", "debug"])
	{
		savedConsole[method] = console[method];
		console[method] = (...args) => lines.push(args.join(" "));
	}
	process.exit = (code) =>
	{
		exits.push(code);
	};
	for (const key of Object.keys(savedEnv))
	{
		delete process.env[key];
	}
	Object.assign(process.env, env);

	try
	{
		await mod.registerNode(options);
	}
	finally
	{
		Object.assign(console, savedConsole);
		delete globalThis.__projectoConsoleTimestamps;
		process.exit = savedExit;
		for (const [key, value] of Object.entries(savedEnv))
		{
			if (value === undefined)
			{
				delete process.env[key];
			}
			else
			{
				process.env[key] = value;
			}
		}
	}

	return { exits, lines };
}

const FULL_ENV = {
	DB_URL: "postgres://user:pass@127.0.0.1:1/db",
	MINIO_ENDPOINT: "minio",
	MINIO_ACCESS_KEY: "key",
	MINIO_SECRET_KEY: "secret",
	KRATOS_PUBLIC_INTERNAL_URL: "http://kratos:4433",
	KRATOS_ADMIN_URL: "http://kratos:4434",
	NEXT_PUBLIC_KRATOS_PUBLIC_URL: "https://auth.example/kratos",
	// These tests are about the Kratos variables; the archiver has its own below.
	ARCHIVER_MODE: "off",
};

const ARCHIVER_ON = { ...FULL_ENV, ARCHIVER_MODE: undefined, PROJECTO_COMPRESSOR_BIN: process.execPath };

test("registerNode exits in production when a required var is missing", async () =>
{
	const { KRATOS_ADMIN_URL, ...env } = FULL_ENV;
	const { exits, lines } = await runRegisterNode({ ...env, NODE_ENV: "production" });

	assert.deepEqual(exits, [1]);
	assert.ok(lines.some((line) => line.includes("KRATOS_ADMIN_URL")));
});

test("registerNode exits in production when the build-time public URL is empty", async () =>
{
	const { NEXT_PUBLIC_KRATOS_PUBLIC_URL, ...env } = FULL_ENV;
	const { exits, lines } = await runRegisterNode({ ...env, NODE_ENV: "production" });

	assert.deepEqual(exits, [1]);
	assert.ok(lines.some((line) => line.includes("NEXT_PUBLIC_KRATOS_PUBLIC_URL")));
});

test("registerNode does not exit in production with the full environment", async () =>
{
	const { exits } = await runRegisterNode({ ...FULL_ENV, NODE_ENV: "production" });

	assert.deepEqual(exits, []);
});

test("registerNode logs but does not exit in development", async () =>
{
	const { exits, lines } = await runRegisterNode({ NODE_ENV: "development" });

	assert.deepEqual(exits, []);
	assert.ok(lines.some((line) => line.includes("Missing environment variables")));
});

// Archiver branches of registerNode. A fake spawnFn is injected, so no worker
// is started; the supervisor calling it is what proves it started.
async function runArchiverCase(env)
{
	const spawned = [];
		const fakeSpawn = (...args) =>
	{
		const child = new EventEmitter();

		spawned.push(args);
		child.pid = 424242;
		child.stdin = new PassThrough();
		child.kill = () =>
		{
			queueMicrotask(() => child.emit("exit", 0, "SIGTERM"));
			return true;
		};

		return child;
	};
	const saved = globalThis.__projectoArchiverSupervisor;

	delete globalThis.__projectoArchiverSupervisor;

	try
	{
		const result = await runRegisterNode(Object.fromEntries(Object.entries(env).filter(([, value]) => value !== undefined)), { spawnFn: fakeSpawn });

		return { ...result, spawned };
	}
	finally
	{
		await globalThis.__projectoArchiverSupervisor?.stop();

		if (saved === undefined)
		{
			delete globalThis.__projectoArchiverSupervisor;
		}
		else
		{
			globalThis.__projectoArchiverSupervisor = saved;
		}
	}
}

test("registerNode with ARCHIVER_MODE=off warns and does not exit", async () =>
{
	const { exits, lines, spawned } = await runArchiverCase({ ...FULL_ENV, NODE_ENV: "production", ARCHIVER_MODE: "off" });

	assert.deepEqual(exits, []);
	assert.ok(lines.some((line) => line.includes("ARCHIVER_MODE=off")));
	assert.ok(!lines.some((line) => line.includes("Archiver worker not started")));
	assert.equal(spawned.length, 0);
});

test("registerNode rejects an invalid ARCHIVER_MODE and exits only in production", async () =>
{
	const prod = await runArchiverCase({ ...ARCHIVER_ON, NODE_ENV: "production", ARCHIVER_MODE: "external" });

	assert.deepEqual(prod.exits, [1]);
	assert.ok(prod.lines.some((line) => line.includes('Invalid ARCHIVER_MODE "external"') && line.includes("embedded")));

	const dev = await runArchiverCase({ ...ARCHIVER_ON, NODE_ENV: "development", ARCHIVER_MODE: "external" });

	assert.deepEqual(dev.exits, []);
	assert.ok(dev.lines.some((line) => line.includes("Invalid ARCHIVER_MODE")));
});

test("registerNode exits in production when the compressor binary is unusable", async () =>
{
	const { exits, lines, spawned } = await runArchiverCase({ ...ARCHIVER_ON, NODE_ENV: "production", PROJECTO_COMPRESSOR_BIN: "relative/bin" });

	assert.deepEqual(exits, [1]);
	assert.equal(spawned.length, 0);
	assert.equal(lines.filter((line) => line.includes("Archiver worker not started")).length, 1);
	assert.ok(lines.some((line) => line.includes("PROJECTO_COMPRESSOR_BIN must be an absolute path")));
});

test("registerNode only logs an unusable compressor binary in development", async () =>
{
	const { PROJECTO_COMPRESSOR_BIN, ...env } = ARCHIVER_ON;
	const { exits, lines } = await runArchiverCase({ ...env, NODE_ENV: "development" });

	assert.deepEqual(exits, []);
	assert.ok(lines.some((line) => line.includes("Archiver worker not started") && line.includes("PROJECTO_COMPRESSOR_BIN is not set")));
});

test("registerNode does not repeat missing DB / MinIO variable names in development", async () =>
{
	const { DB_URL, ...env } = ARCHIVER_ON;
	const { exits, lines } = await runArchiverCase({ ...env, NODE_ENV: "development" });
	const named = lines.filter((line) => line.includes("DB_URL"));

	assert.deepEqual(exits, []);
	assert.equal(named.length, 1);
	assert.ok(lines.some((line) => line.includes("Archiver worker not started") && line.includes("listed above")));
});

test("registerNode starts the supervisor when the environment is complete", async () =>
{
	const { exits, lines, spawned } = await runArchiverCase({ ...ARCHIVER_ON, NODE_ENV: "production" });

	assert.deepEqual(exits, []);
	assert.ok(!lines.some((line) => line.includes("Archiver worker not started") || line.includes("ARCHIVER_MODE")));
	assert.equal(spawned.length, 1);
	assert.ok(spawned[0][1].some((arg) => String(arg).endsWith(path.join("worker", "archiver", "main.js"))));
});
