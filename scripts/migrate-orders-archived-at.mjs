// One-time migration: adds orders.archived_at (and its partial index) used by
// the order auto-archiver. The SQL lives in db/migrations/2026-11-11_orders_archived_at.sql.
//
//   DB_URL=postgres://user:pass@host:5432/db bun scripts/migrate-orders-archived-at.mjs [--dry-run]
//
// --dry-run only reports whether the column and index exist and what would be done.
// Idempotent: running it again changes nothing.

import postgres from "postgres";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const DB_URL = process.env.DB_URL;
const dryRun = process.argv.includes("--dry-run");
const SQL_PATH = fileURLToPath(new URL("../db/migrations/2026-11-11_orders_archived_at.sql", import.meta.url));
const INDEX_NAME = "orders_archive_candidates_idx";

if (!DB_URL)
{
	console.error("DB_URL is not set. Example: DB_URL=postgres://user:pass@host:5432/db bun scripts/migrate-orders-archived-at.mjs");
	process.exit(1);
}

const sql = postgres(DB_URL, { max: 1, onnotice: () => undefined });

async function checkState()
{
	const columns = await sql`
		SELECT 1
		FROM information_schema.columns
		WHERE table_schema = current_schema()
			AND table_name = 'orders'
			AND column_name = 'archived_at'
	`;
	const indexes = await sql`
		SELECT 1
		FROM pg_indexes
		WHERE schemaname = current_schema()
			AND tablename = 'orders'
			AND indexname = ${INDEX_NAME}
	`;

	return { column: columns.length > 0, index: indexes.length > 0 };
}

function describe(state)
{
	return `column orders.archived_at: ${state.column ? "exists" : "missing"}, index ${INDEX_NAME}: ${state.index ? "exists" : "missing"}`;
}

let exitCode = 0;

try
{
	const before = await checkState();

	console.log(describe(before));

	if (before.column && before.index)
	{
		console.log("Nothing to do.");
	}
	else if (dryRun)
	{
		const todo = [];

		if (!before.column)
		{
			todo.push("add column orders.archived_at");
		}

		if (!before.index)
		{
			todo.push(`create index ${INDEX_NAME}`);
		}

		console.log(`[dry-run] would: ${todo.join(", ")}`);
	}
	else
	{
		await sql.unsafe(readFileSync(SQL_PATH, "utf8"));

		const after = await checkState();

		console.log(`after migration - ${describe(after)}`);

		if (!after.column || !after.index)
		{
			throw new Error("Migration ran but the column or index is still missing");
		}

		console.log("Migration applied.");
	}
}
catch (err)
{
	console.error(`FAILED: ${err.message}`);
	exitCode = 1;
}
finally
{
	await sql.end();
}

process.exit(exitCode);
