// Server-side logger (also imported by src/instrumentation.js, so no
// "server-only" import here). Timestamps are added to every console line by
// src/instrumentation.js; this adds the level and a [scope] tag.
// LOG_LEVEL=debug|info|warn|error (default: info).
//
// Never log patient names, emails or passwords; use ids.

const LEVELS = {
	debug: 10,
	info: 20,
	warn: 30,
	error: 40,
};

const threshold =
	LEVELS[String(process.env.LOG_LEVEL || "").toLowerCase()] ?? LEVELS.info;

const CONSOLE_METHODS = {
	debug: "log",
	info: "log",
	warn: "warn",
	error: "error",
};

export function createLogger(scope)
{
	const write = (level) => (message, details) =>
	{
		if (LEVELS[level] < threshold)
		{
			return;
		}

		const line = `${level.toUpperCase().padEnd(5)} [${scope}] ${message}`;
		const method = CONSOLE_METHODS[level];

		if (details === undefined)
		{
			console[method](line);
		}
		else
		{
			console[method](line, details);
		}
	};

	return {
		debug: write("debug"),
		info: write("info"),
		warn: write("warn"),
		error: write("error"),
	};
}
