import "server-only";

import postgres from "postgres";

// One pool per server process. Creating a pool per request opened a new
// connection for every query and exhausted Postgres under load.
// Kept on globalThis so dev-mode hot reloads don't leak pools.
const globalForDb = globalThis;

// postgres(undefined) silently falls back to libpq defaults (localhost, OS
// user), which fails late and confusingly. `next build` imports this module
// without runtime env, so the check is skipped during the build.
if (
	!process.env.DB_URL &&
	process.env.NODE_ENV === "production" &&
	process.env.NEXT_PHASE !== "phase-production-build"
)
{
	throw new Error("DB_URL is not set");
}

export const DB =
	globalForDb.__projectoDb ??
	(globalForDb.__projectoDb = postgres(process.env.DB_URL, {
		prepare: true,
		max: Number(process.env.DB_POOL_MAX) || 10,
		idle_timeout: 30,
		connect_timeout: 10,
		connection: {
			statement_timeout: 15000,
		},
		// ssl: "require",
	}));
