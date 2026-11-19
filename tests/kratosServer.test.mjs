import test from "node:test";
import assert from "node:assert/strict";

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
async function runRegisterNode(env)
{
	const mod = await importWithEnv(INSTRUMENTATION, {});
	const savedEnv = Object.fromEntries(
		[...ENV_KEYS, "MINIO_ENDPOINT", "MINIO_ACCESS_KEY", "MINIO_SECRET_KEY"].map((key) => [key, process.env[key]]),
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
		await mod.registerNode();
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
};

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
