#!/usr/bin/env bun
// One-time migration for the native archive worker. Runs, in order:
//   db/migrations/2026-11-19_archive_jobs.sql
//     archive_jobs, archive_workers, archive_pending_verify and the
//     archive_jobs_one_active_idx partial unique index
//   db/migrations/2026-11-20_archive_pending_verify_job_fk.sql
//     ON DELETE RESTRICT on archive_pending_verify.job_id (a job cannot be deleted while
//     it has journal rows) and an index on it
//
//   DB_URL=postgres://user:pass@host:5432/db bun scripts/migrate-archive-jobs.mjs [--dry-run]
//
// --dry-run prints the statements that would run. If DB_URL is set it also reads the
// current state (read-only); without DB_URL it does not connect at all.
// Idempotent: running it again changes nothing.
//
// A table that exists but lacks a column or an allowed state value is reported
// as outdated and the script stops: CREATE TABLE IF NOT EXISTS would not fix it,
// so it needs a manual migration. The run holds an advisory lock shared by all
// migration scripts, so two runs cannot interleave.

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
const BASE_SQL_PATH = fileURLToPath(new URL("../db/migrations/2026-11-19_archive_jobs.sql", import.meta.url));
const FK_SQL_PATH = fileURLToPath(new URL("../db/migrations/2026-11-20_archive_pending_verify_job_fk.sql", import.meta.url));
const ACTIVE_INDEX = "archive_jobs_one_active_idx";
const JOB_ID_INDEX = "archive_pending_verify_job_id_idx";

// Columns and CHECK values the worker relies on, as created by 2026-11-19_archive_jobs.sql.
const EXPECTED_TABLES = {
	archive_jobs: {
		columns: [
			"id", "state", "triggered_by", "worker_id", "created_at", "started_at",
			"finished_at", "heartbeat_at", "progress", "last_error",
		],
		stateValues: ["queued", "running", "done", "failed", "interrupted"],
	},
	archive_workers: {
		columns: ["worker_id", "version", "started_at", "heartbeat_at"],
		stateValues: [],
	},
	archive_pending_verify: {
		columns: [
			"file_id", "job_id", "method", "original_sha256", "original_size", "stored_size",
			"pre_upload_etag", "stored_etag", "original_path", "state", "note", "created_at", "updated_at",
		],
		stateValues: ["uploading", "uploaded", "needs_attention"],
	},
};
const TABLES = Object.keys(EXPECTED_TABLES);

if (!DB_URL && !dryRun)
{
	console.error("DB_URL is not set. Example: DB_URL=postgres://user:pass@host:5432/db bun scripts/migrate-archive-jobs.mjs");
	process.exit(1);
}

const sql = DB_URL ? postgres(DB_URL, { max: 1, onnotice: () => undefined }) : null;

// Lists what an existing table is missing compared with EXPECTED_TABLES.
async function findOutdated(existingTables)
{
	const columns = await sql`
		SELECT table_name, column_name
		FROM information_schema.columns
		WHERE table_schema = current_schema()
			AND table_name IN ${sql(TABLES)}
	`;
	const checks = await sql`
		SELECT c.relname AS table_name, pg_get_constraintdef(k.oid) AS definition
		FROM pg_constraint k
		JOIN pg_class c ON c.oid = k.conrelid
		JOIN pg_namespace n ON n.oid = c.relnamespace
		WHERE n.nspname = current_schema()
			AND k.contype = 'c'
			AND c.relname IN ${sql(TABLES)}
	`;

	return TABLES
		.filter((table) => existingTables.has(table))
		.flatMap((table) =>
		{
			const { columns: expectedColumns, stateValues } = EXPECTED_TABLES[table];
			const present = new Set(columns.filter((row) => row.table_name === table).map((row) => row.column_name));
			const missingColumns = expectedColumns.filter((column) => !present.has(column));
			const stateCheck = checks.find((row) => row.table_name === table && /\bstate\b/.test(row.definition));
			const missingValues = stateValues.filter((value) => !stateCheck?.definition.includes(`'${value}'`));
			const problems = [];

			if (missingColumns.length > 0)
			{
				problems.push(`${table} lacks column(s) ${missingColumns.join(", ")}`);
			}

			if (missingValues.length > 0)
			{
				problems.push(`${table}.state does not allow ${missingValues.join(", ")}`);
			}

			return problems;
		});
}

async function jobForeignKeyRestricts()
{
	const rows = await sql`
		SELECT bool_and(k.confdeltype = 'r') AS restricts
		FROM pg_constraint k
		JOIN pg_class c ON c.oid = k.conrelid
		JOIN pg_class r ON r.oid = k.confrelid
		JOIN pg_namespace n ON n.oid = c.relnamespace
		WHERE n.nspname = current_schema()
			AND k.contype = 'f'
			AND c.relname = 'archive_pending_verify'
			AND r.relname = 'archive_jobs'
	`;

	return rows[0]?.restricts === true;
}

async function checkState()
{
	const tables = await sql`
		SELECT tablename
		FROM pg_tables
		WHERE schemaname = current_schema()
			AND tablename IN ${sql(TABLES)}
	`;
	const existing = new Set(tables.map((row) => row.tablename));
	const missingTables = TABLES.filter((name) => !existing.has(name));
	const verifyTableExists = existing.has("archive_pending_verify") && existing.has("archive_jobs");

	return {
		missingTables,
		outdated: await findOutdated(existing),
		activeIndex: await indexState(sql, ACTIVE_INDEX),
		restrict: verifyTableExists && await jobForeignKeyRestricts(),
		jobIdIndex: await indexState(sql, JOB_ID_INDEX),
	};
}

function baseComplete(state)
{
	return state.missingTables.length === 0 && state.activeIndex === "valid";
}

function followUpComplete(state)
{
	return state.restrict && state.jobIdIndex === "valid";
}

function describe(state)
{
	const tables = state.missingTables.length === 0 ? "all present" : `missing ${state.missingTables.join(", ")}`;

	return [
		`tables: ${tables}`,
		`index ${ACTIVE_INDEX}: ${state.activeIndex}`,
		`archive_pending_verify.job_id ON DELETE RESTRICT: ${state.restrict ? "yes" : "no"}`,
		`index ${JOB_ID_INDEX}: ${state.jobIdIndex}`,
	].join("; ");
}

function assertNotOutdated(state)
{
	if (state.outdated.length > 0)
	{
		throw new Error(`Existing tables have an outdated structure, fix them by hand first: ${state.outdated.join("; ")}`);
	}
}

async function migrate()
{
	const before = await checkState();

	console.log(describe(before));
	assertNotOutdated(before);

	if (baseComplete(before) && followUpComplete(before))
	{
		console.log("Nothing to do.");
		return;
	}

	if (!baseComplete(before))
	{
		// The partial unique index is built inside the base migration's transaction, so it is never left invalid.
		await runStatements(sql, splitSqlStatements(readFileSync(BASE_SQL_PATH, "utf8")));
		console.log(`applied ${BASE_SQL_PATH}`);
	}

	await dropInvalidIndex(sql, JOB_ID_INDEX);
	await runStatements(sql, splitSqlStatements(readFileSync(FK_SQL_PATH, "utf8")));
	console.log(`applied ${FK_SQL_PATH}`);

	const after = await checkState();

	console.log(`after migration - ${describe(after)}`);
	assertNotOutdated(after);

	if (!baseComplete(after) || !followUpComplete(after))
	{
		throw new Error("Migration ran but a table, index or the restricting foreign key is still missing");
	}

	console.log("Migration applied.");
}

let exitCode = 0;

try
{
	if (dryRun)
	{
		for (const path of [BASE_SQL_PATH, FK_SQL_PATH])
		{
			console.log(`[dry-run] statements from ${path}:`);
			console.log(splitSqlStatements(readFileSync(path, "utf8")).map((statement) => `${statement};`).join("\n\n"));
		}

		if (sql)
		{
			const state = await checkState();

			console.log(`[dry-run] current state: ${describe(state)}`);

			if (state.outdated.length > 0)
			{
				console.log(`[dry-run] outdated structure, a real run would stop: ${state.outdated.join("; ")}`);
			}
			else if (baseComplete(state) && followUpComplete(state))
			{
				console.log("[dry-run] nothing to do.");
			}
			else
			{
				const files = baseComplete(state) ? [FK_SQL_PATH] : [BASE_SQL_PATH, FK_SQL_PATH];

				console.log(`[dry-run] would run: ${files.join(", ")}`);
			}
		}
		else
		{
			console.log("[dry-run] DB_URL not set, current state not checked.");
		}
	}
	else
	{
		await withMigrationLock(sql, migrate);
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
