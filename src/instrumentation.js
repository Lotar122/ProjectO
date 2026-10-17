// Runs once when the Next.js server starts.

const CONSOLE_METHODS = ["log", "info", "warn", "error", "debug"];

const REQUIRED_ENV = [
	"DB_URL",
	"MINIO_ENDPOINT",
	"MINIO_ACCESS_KEY",
	"MINIO_SECRET_KEY",
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

export async function register()
{
	if (process.env.NEXT_RUNTIME !== "nodejs")
	{
		return;
	}

	addConsoleTimestamps();

	const { createLogger } = await import("./app/lib/logger");
	const log = createLogger("server");

	log.info(`Starting (NODE_ENV=${process.env.NODE_ENV}, node ${process.version})`);

	const missingEnv = REQUIRED_ENV.filter((name) => !process.env[name]);

	if (missingEnv.length > 0)
	{
		log.error(`Missing environment variables: ${missingEnv.join(", ")}`);
	}
}
