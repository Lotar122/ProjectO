// Node.js-only startup code, loaded from src/instrumentation.js. Kept in its
// own module so the Edge build never sees the Node APIs used here.

const CONSOLE_METHODS = ["log", "info", "warn", "error", "debug"];

const REQUIRED_ENV = [
	"DB_URL",
	"MINIO_ENDPOINT",
	"MINIO_ACCESS_KEY",
	"MINIO_SECRET_KEY",
];

// Only required in production; development falls back to local defaults.
const REQUIRED_PRODUCTION_ENV = [
	"KRATOS_PUBLIC_INTERNAL_URL",
	"KRATOS_ADMIN_URL",
];

// Prefix every server console line with an ISO timestamp, including output
// from Next.js itself and from libraries.
function addConsoleTimestamps()
{
	if (globalThis.__projectoConsoleTimestamps)
	{
		return;
	}

	globalThis.__projectoConsoleTimestamps = true;

	for (const method of CONSOLE_METHODS)
	{
		const original = console[method].bind(console);

		console[method] = (...args) =>
		{
			const timestamp = new Date().toISOString();

			// Merge into a leading string so printf-style "%s" formatting still works.
			if (typeof args[0] === "string")
			{
				original(`${timestamp} ${args[0]}`, ...args.slice(1));
			}
			else
			{
				original(timestamp, ...args);
			}
		};
	}
}

/**
 * @param {object} [options]
 * @param {typeof import("node:child_process").spawn} [options.spawnFn] Replaces child_process.spawn for the archiver worker (tests).
 * @returns {Promise<void>}
 */
export async function registerNode({ spawnFn } = {})
{
	addConsoleTimestamps();

	const { createLogger } = await import("./app/lib/logger");
	const log = createLogger("server");

	log.info(`Starting (NODE_ENV=${process.env.NODE_ENV}, node ${process.version})`);

	const isProduction = process.env.NODE_ENV === "production";
	const required = isProduction ?
		[...REQUIRED_ENV, ...REQUIRED_PRODUCTION_ENV] :
		REQUIRED_ENV;
	const missingEnv = required.filter((name) => !process.env[name]);

	// NEXT_PUBLIC_* is inlined at build time, so this must be a literal
	// reference: a dynamic process.env[name] would read the runtime env, which
	// a deploy that only passes the value as a build arg does not have.
	if (isProduction && !process.env.NEXT_PUBLIC_KRATOS_PUBLIC_URL)
	{
		missingEnv.push("NEXT_PUBLIC_KRATOS_PUBLIC_URL (build-time)");
	}

	if (missingEnv.length > 0)
	{
		log.error(`Missing environment variables: ${missingEnv.join(", ")}`);

		if (isProduction)
		{
			process.exit(1);
		}
	}

	// The bundled supervisor is the only compressor path. "off" is an explicit
	// opt-out for builds, tests and development without the binary.
	const archiverMode = process.env.ARCHIVER_MODE || "embedded";

	if (archiverMode === "off")
	{
		log.warn("ARCHIVER_MODE=off: archiver worker not started, orders will not be compressed");
		return;
	}

	if (archiverMode !== "embedded")
	{
		log.error(`Invalid ARCHIVER_MODE "${archiverMode}" (expected "off" to disable, or "embedded" or unset to run the supervised worker)`);

		if (isProduction)
		{
			process.exit(1);
		}

		return;
	}

	const { checkArchiverEnv, startArchiverSupervisor } = await import("./app/server-functions/orders/archiverSupervisor");
	// registerNode already logged any missing DB / MinIO variable by name above.
	const problems = checkArchiverEnv(process.env, { workerEnv: false });

	if (REQUIRED_ENV.some((name) => !process.env[name]))
	{
		problems.unshift("DB / MinIO variables are missing (listed above)");
	}

	if (problems.length > 0)
	{
		// One line, so the cause is visible in the log. Starting anyway would only
		// loop on a worker that exits at once.
		log.error(`Archiver worker not started: ${problems.join("; ")}`);

		if (isProduction)
		{
			process.exit(1);
		}

		return;
	}

	startArchiverSupervisor({ env: process.env, log: createLogger("archiver-supervisor"), spawnFn });
}
