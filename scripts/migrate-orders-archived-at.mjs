#!/usr/bin/env bun
// One-time migration: adds orders.archived_at (and its partial index) used by
// the order auto-archiver. The SQL lives in db/migrations/2026-11-11_orders_archived_at.sql.
//
//   DB_URL=postgres://user:pass@host:5432/db bun scripts/migrate-orders-archived-at.mjs [--dry-run]
//
// --dry-run only reports whether the column and index exist and what would be done.
// Idempotent: running it again changes nothing.
//
// The statements run one at a time (CREATE INDEX CONCURRENTLY cannot run in a
// transaction), the ALTER gives up after lock_timeout instead of blocking the
// orders table, and an invalid index left by an earlier failed run is dropped
// and built again.

import postgres from "postgres";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
	dropInvalidIndex,
	indexState,
	runStatements,
	splitSqlStatements,
	withMigrationLock,
} from "./lib/migration.mjs";

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

	return { column: columns.length > 0, index: await indexState(sql, INDEX_NAME) };
}

function describe(state)
{
	return `column orders.archived_at: ${state.column ? "exists" : "missing"}, index ${INDEX_NAME}: ${state.index}`;
}

function isComplete(state)
{
	return state.column && state.index === "valid";
}

function plannedSteps(state)
{
	const steps = [];

	if (!state.column)
	{
		steps.push("add column orders.archived_at");
	}

	if (state.index === "invalid")
	{
		steps.push(`drop the invalid index ${INDEX_NAME} left by a failed run`);
	}

	if (state.index !== "valid")
	{
		steps.push(`create index ${INDEX_NAME} concurrently`);
	}

	return steps;
}

let exitCode = 0;

try
{
	const statements = splitSqlStatements(readFileSync(SQL_PATH, "utf8"));
	const before = await checkState();

	console.log(describe(before));

	if (isComplete(before))
	{
		console.log("Nothing to do.");
	}
	else if (dryRun)
	{
		console.log(`[dry-run] would: ${plannedSteps(before).join(", ")}`);
	}
	else
	{
		await withMigrationLock(sql, async () =>
		{
			await dropInvalidIndex(sql, INDEX_NAME);
			await runStatements(sql, statements);
		});

		const after = await checkState();

		console.log(`after migration - ${describe(after)}`);

		if (!isComplete(after))
		{
			throw new Error("Migration ran but the column or a valid index is still missing");
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
