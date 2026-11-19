#!/usr/bin/env bun
// One-time migration: creates archive_jobs, archive_workers and archive_pending_verify
// and the archive_jobs_one_active_idx partial unique index used by the native archive worker.
// The SQL lives in db/migrations/2026-11-19_archive_jobs.sql.
//
//   DB_URL=postgres://user:pass@host:5432/db bun scripts/migrate-archive-jobs.mjs [--dry-run]
//
// --dry-run prints the statements that would run. If DB_URL is set it also reads the
// current state (read-only); without DB_URL it does not connect at all.
// Idempotent: running it again changes nothing.

import postgres from "postgres";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const DB_URL = process.env.DB_URL;
const dryRun = process.argv.includes("--dry-run");
const SQL_PATH = fileURLToPath(new URL("../db/migrations/2026-11-19_archive_jobs.sql", import.meta.url));
const TABLES = ["archive_jobs", "archive_workers", "archive_pending_verify"];
const INDEX_NAME = "archive_jobs_one_active_idx";

if (!DB_URL && !dryRun)
{
	console.error("DB_URL is not set. Example: DB_URL=postgres://user:pass@host:5432/db bun scripts/migrate-archive-jobs.mjs");
	process.exit(1);
}

const sql = DB_URL ? postgres(DB_URL, { max: 1, onnotice: () => undefined }) : null;

async function checkState()
{
	const tables = await sql`
		SELECT tablename
		FROM pg_tables
		WHERE schemaname = current_schema()
			AND tablename IN ${sql(TABLES)}
	`;
	const indexes = await sql`
		SELECT indexname
		FROM pg_indexes
		WHERE schemaname = current_schema()
			AND indexname = ${INDEX_NAME}
	`;
	const existing = new Set(tables.map((row) => row.tablename));

	return {
		missingTables: TABLES.filter((name) => !existing.has(name)),
		index: indexes.length > 0
	};
}

function isComplete(state)
{
	return state.missingTables.length === 0 && state.index;
}

function describe(state)
{
	const tables = state.missingTables.length === 0 ? "all present" : `missing ${state.missingTables.join(", ")}`;

	return `tables: ${tables}; index ${INDEX_NAME}: ${state.index ? "exists" : "missing"}`;
}

let exitCode = 0;

try
{
	const migrationSql = readFileSync(SQL_PATH, "utf8");

	if (dryRun)
	{
		console.log(`[dry-run] statements from ${SQL_PATH}:`);
		console.log(migrationSql);

		if (sql)
		{
			const state = await checkState();

			console.log(`[dry-run] current state: ${describe(state)}`);
			console.log(isComplete(state) ? "[dry-run] nothing to do." : "[dry-run] would run the statements above.");
		}
		else
		{
			console.log("[dry-run] DB_URL not set, current state not checked.");
		}
	}
	else
	{
		const before = await checkState();

		console.log(describe(before));

		if (isComplete(before))
		{
			console.log("Nothing to do.");
		}
		else
		{
			await sql.unsafe(migrationSql);

			const after = await checkState();

			console.log(`after migration - ${describe(after)}`);

			if (!isComplete(after))
			{
				throw new Error("Migration ran but tables or index are still missing");
			}

			console.log("Migration applied.");
		}
	}
}
catch (err)
{
	console.error(`FAILED: ${err.message}`);
	exitCode = 1;
}
finally
{
	await sql?.end();
}

process.exit(exitCode);
