// Helpers shared by the migration scripts (scripts/lib/migration.mjs), tested
// with a recording stand-in for the postgres client. No database is used.

import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";

import {
	dropInvalidIndex,
	indexState,
	runStatements,
	splitSqlStatements,
	withMigrationLock,
} from "../scripts/lib/migration.mjs";

const MIGRATIONS_DIR = new URL("../db/migrations/", import.meta.url);

// Minimal postgres.js stand-in: `sql\`...\`` and `sql.unsafe(text)` both record the
// statement text and answer from `handlers` (first regex that matches) or [].
function createFakeSql(handlers = [])
{
	const log = [];

	const answer = (text, values) =>
	{
		log.push({ text, values });

		const handler = handlers.find(({ pattern }) => pattern.test(text));

		if (!handler)
		{
			return Promise.resolve([]);
		}

		return typeof handler.result === "function" ? handler.result(text, values) : Promise.resolve(handler.result);
	};

	const sql = (strings, ...values) => answer(strings.join("?").replace(/\s+/g, " ").trim(), values);

	sql.unsafe = (text) => answer(text, []);

	return { sql, log, texts: () => log.map((entry) => entry.text) };
}

describe("splitSqlStatements", () =>
{
	test("splits on semicolons, drops the semicolons and empty statements", () =>
	{
		expect(splitSqlStatements("SELECT 1;\n\n;  ;\nSELECT 2;")).toEqual(["SELECT 1", "SELECT 2"]);
	});

	test("keeps a final statement that has no semicolon", () =>
	{
		expect(splitSqlStatements("SELECT 1; SELECT 2")).toEqual(["SELECT 1", "SELECT 2"]);
	});

	test("returns nothing for empty or comment-only input", () =>
	{
		expect(splitSqlStatements("")).toEqual([]);
		expect(splitSqlStatements("  \n\t ")).toEqual([]);
		expect(splitSqlStatements("-- nothing here;\n/* nor here; */")).toEqual([]);
	});

	test("ignores semicolons in line comments and removes the comments", () =>
	{
		expect(splitSqlStatements("-- header; not a statement\nSELECT 1 -- trailing; note\n;\nSELECT 2;")).toEqual([
			"SELECT 1",
			"SELECT 2",
		]);
	});

	test("ignores semicolons in block comments and replaces them with a space", () =>
	{
		expect(splitSqlStatements("SELECT/* a; b */1; /* only; */ SELECT 2;")).toEqual(["SELECT 1", "SELECT 2"]);
	});

	test("an unterminated block comment swallows the rest of the file", () =>
	{
		expect(splitSqlStatements("SELECT 1; /* never closed; SELECT 2;")).toEqual(["SELECT 1"]);
	});

	test("keeps semicolons and comment markers inside quoted strings", () =>
	{
		expect(splitSqlStatements("INSERT INTO t VALUES ('a;b', '-- not a comment', '/* nor this */');")).toEqual([
			"INSERT INTO t VALUES ('a;b', '-- not a comment', '/* nor this */')",
		]);
	});

	test("understands doubled quotes as escapes in strings and identifiers", () =>
	{
		expect(splitSqlStatements("SELECT 'it''s; fine'; SELECT \"we\"\"ird;col\" FROM t;")).toEqual([
			"SELECT 'it''s; fine'",
			"SELECT \"we\"\"ird;col\" FROM t",
		]);
	});

	test("keeps a DO block with an anonymous dollar-quoted body in one statement", () =>
	{
		const doBlock = "DO $$ BEGIN PERFORM 1; PERFORM 2; END $$";

		expect(splitSqlStatements(`${doBlock}; SELECT 1;`)).toEqual([doBlock, "SELECT 1"]);
	});

	test("matches dollar-quote tags exactly, so a different inner tag does not end the body", () =>
	{
		const body = "DO $outer$ BEGIN EXECUTE $inner$ SELECT 1; $inner$; END $outer$";

		expect(splitSqlStatements(`${body};\nSELECT 2;`)).toEqual([body, "SELECT 2"]);
	});

	test("keeps comments inside a dollar-quoted body untouched", () =>
	{
		const body = "DO $$ BEGIN -- keep; me\n PERFORM 1; END $$";

		expect(splitSqlStatements(`${body};`)).toEqual([body]);
	});

	test("an unterminated string or dollar-quote runs to the end of the text", () =>
	{
		expect(splitSqlStatements("SELECT 'open; SELECT 2;")).toEqual(["SELECT 'open; SELECT 2;"]);
		expect(splitSqlStatements("DO $$ BEGIN; SELECT 2;")).toEqual(["DO $$ BEGIN; SELECT 2;"]);
	});

	test("positional parameters like $1 are not dollar quotes", () =>
	{
		expect(splitSqlStatements("SELECT $1; SELECT $2;")).toEqual(["SELECT $1", "SELECT $2"]);
	});

	test("keeps explicit transaction statements as separate statements", () =>
	{
		expect(splitSqlStatements("BEGIN;\nALTER TABLE t ADD COLUMN c int;\nCOMMIT;")).toEqual([
			"BEGIN",
			"ALTER TABLE t ADD COLUMN c int",
			"COMMIT",
		]);
	});

	test("accepts CRLF line endings", () =>
	{
		expect(splitSqlStatements("-- c\r\nSELECT 1;\r\nSELECT 2;\r\n")).toEqual(["SELECT 1", "SELECT 2"]);
	});

	test("throws a TypeError for non-string input", () =>
	{
		expect(() => splitSqlStatements(undefined)).toThrow(TypeError);
		expect(() => splitSqlStatements(Buffer.from("SELECT 1"))).toThrow(TypeError);
	});

	// A `$tag$` inside an identifier (valid in Postgres, e.g. my$tag$x) is not a
	// dollar-quote start; only a tag not preceded by an identifier char is.
	test("a dollar sign inside an identifier does not start a dollar-quoted body", () =>
	{
		expect(splitSqlStatements("CREATE TABLE my$tag$x (id int); SELECT 1;")).toEqual([
			"CREATE TABLE my$tag$x (id int)",
			"SELECT 1",
		]);
		expect(splitSqlStatements("SELECT a1$$b; SELECT 2;")).toEqual(["SELECT a1$$b", "SELECT 2"]);
		expect(splitSqlStatements("SELECT \u00e9$t$x; SELECT 2;")).toEqual(["SELECT \u00e9$t$x", "SELECT 2"]);
	});

	test("a dollar-quote tag still starts a body after a non-identifier character", () =>
	{
		const anon = "DO $$ BEGIN PERFORM 1; PERFORM 2; END $$";
		const named = "CREATE FUNCTION f() RETURNS int AS $fn$ BEGIN RETURN 1; END; $fn$ LANGUAGE plpgsql";

		expect(splitSqlStatements(`${anon}; SELECT 1;`)).toEqual([anon, "SELECT 1"]);
		expect(splitSqlStatements(`${named};\nSELECT 2;`)).toEqual([named, "SELECT 2"]);
		expect(splitSqlStatements("SELECT($$a;b$$); SELECT 3;")).toEqual(["SELECT($$a;b$$)", "SELECT 3"]);
		expect(splitSqlStatements("SELECT my$tag$x, $t$ ; $t$; SELECT 4;")).toEqual([
			"SELECT my$tag$x, $t$ ; $t$",
			"SELECT 4",
		]);
	});

	test("a named dollar-quoted body may contain nested anonymous quotes", () =>
	{
		const body = "CREATE FUNCTION g() RETURNS void AS $fn$ BEGIN EXECUTE $$ SELECT 1; $$; END; $fn$ LANGUAGE plpgsql";

		expect(splitSqlStatements(`${body}; SELECT 5;`)).toEqual([body, "SELECT 5"]);
	});

	test("honors backslash escapes in E'...' strings, so \\' does not end the string", () =>
	{
		expect(splitSqlStatements("SELECT E'it\\'s;x'; SELECT 2;")).toEqual(["SELECT E'it\\'s;x'", "SELECT 2"]);
		expect(splitSqlStatements("SELECT e'a\\\\'; SELECT 2;")).toEqual(["SELECT e'a\\\\'", "SELECT 2"]);
		expect(splitSqlStatements("SELECT E'a''b\\';c'; SELECT 3;")).toEqual(["SELECT E'a''b\\';c'", "SELECT 3"]);
	});

	test("a backslash is an ordinary character in a plain string and after a longer word", () =>
	{
		expect(splitSqlStatements("SELECT 'a\\'; SELECT 2;")).toEqual(["SELECT 'a\\'", "SELECT 2"]);
		expect(splitSqlStatements("SELECT fooE'a\\'; SELECT 2;")).toEqual(["SELECT fooE'a\\'", "SELECT 2"]);
	});

	test("block comments nest, as in PostgreSQL", () =>
	{
		expect(splitSqlStatements("SELECT /* a /* b; */ c; */ 1; SELECT 2;")).toEqual(["SELECT   1", "SELECT 2"]);
		expect(splitSqlStatements("/* /* */ ; */ SELECT 1;")).toEqual(["SELECT 1"]);
		expect(splitSqlStatements("SELECT 1; /* /* inner closed */ outer open; SELECT 2;")).toEqual(["SELECT 1"]);
	});

	test("splits the archive_pending_verify FK migration into SET, DO, RESET and CREATE INDEX CONCURRENTLY", () =>
	{
		const text = readFileSync(new URL("2026-11-20_archive_pending_verify_job_fk.sql", MIGRATIONS_DIR), "utf8");
		const statements = splitSqlStatements(text);

		expect(statements).toHaveLength(4);
		expect(statements[0]).toBe("SET lock_timeout = '5s'");
		expect(statements[1]).toMatch(/^DO \$\$\nDECLARE/);
		expect(statements[1]).toMatch(/END\n\$\$$/);
		expect(statements[1]).toContain("ADD CONSTRAINT archive_pending_verify_job_id_fkey");
		expect(statements[1]).toContain("END IF;");
		expect(statements[2]).toBe("RESET lock_timeout");
		expect(statements[3]).toMatch(/^CREATE INDEX CONCURRENTLY IF NOT EXISTS archive_pending_verify_job_id_idx\s+ON archive_pending_verify \(job_id\)$/);
	});

	test("scans a large input in linear time", () =>
	{
		const text = "SELECT 'x;y' /* c */;\n".repeat(20_000);
		const started = performance.now();

		expect(splitSqlStatements(text)).toHaveLength(20_000);
		expect(performance.now() - started).toBeLessThan(2_000);
	});

	test("splits every migration file in db/migrations into non-empty statements", () =>
	{
		const files = readdirSync(MIGRATIONS_DIR).filter((name) => name.endsWith(".sql"));

		expect(files.length).toBeGreaterThan(0);

		for (const name of files)
		{
			const statements = splitSqlStatements(readFileSync(new URL(name, MIGRATIONS_DIR), "utf8"));

			expect(statements.length).toBeGreaterThan(0);
			expect(statements.every((statement) => statement.trim() === statement && !statement.endsWith(";"))).toBe(true);
		}
	});
});

describe("runStatements", () =>
{
	test("runs the statements in order", async () =>
	{
		const { sql, texts } = createFakeSql();

		await runStatements(sql, ["SELECT 1", "SELECT 2", "SELECT 3"]);

		expect(texts()).toEqual(["SELECT 1", "SELECT 2", "SELECT 3"]);
	});

	test("a failure outside a transaction block is rethrown with the statement, with no ROLLBACK", async () =>
	{
		const failure = Object.assign(new Error("boom"), { code: "42P01" });
		const { sql, texts } = createFakeSql([{ pattern: /^SELECT 2/, result: () => Promise.reject(failure) }]);

		const error = await runStatements(sql, ["SELECT 1", "SELECT 2\nFROM nowhere", "SELECT 3"]).then(() => null, (err) => err);

		expect(error).toBe(failure);
		expect(error.message).toBe("boom (while running: SELECT 2)");
		expect(texts()).toEqual(["SELECT 1", "SELECT 2\nFROM nowhere"]);
	});

	test("a failure inside BEGIN ... COMMIT rolls back before rethrowing", async () =>
	{
		const { sql, texts } = createFakeSql([{ pattern: /^ALTER/, result: () => Promise.reject(new Error("bad alter")) }]);

		await expect(runStatements(sql, ["BEGIN", "ALTER TABLE t ADD COLUMN c int", "COMMIT"])).rejects.toThrow(/bad alter/);
		expect(texts()).toEqual(["BEGIN", "ALTER TABLE t ADD COLUMN c int", "ROLLBACK"]);
	});

	test("START TRANSACTION opens a block too, and COMMIT closes it", async () =>
	{
		const failing = createFakeSql([{ pattern: /^FAIL/, result: () => Promise.reject(new Error("x")) }]);

		await expect(runStatements(failing.sql, ["start transaction", "FAIL"])).rejects.toThrow();
		expect(failing.texts()).toEqual(["start transaction", "FAIL", "ROLLBACK"]);

		const afterCommit = createFakeSql([{ pattern: /^FAIL/, result: () => Promise.reject(new Error("x")) }]);

		await expect(runStatements(afterCommit.sql, ["BEGIN", "SELECT 1", "COMMIT", "FAIL"])).rejects.toThrow();
		expect(afterCommit.texts()).toEqual(["BEGIN", "SELECT 1", "COMMIT", "FAIL"]);
	});

	test.each(["ROLLBACK", "END", "ABORT"])("%s also ends a block", async (ending) =>
	{
		const { sql, texts } = createFakeSql([{ pattern: /^FAIL/, result: () => Promise.reject(new Error("x")) }]);

		await expect(runStatements(sql, ["BEGIN", ending, "FAIL"])).rejects.toThrow();
		expect(texts()).toEqual(["BEGIN", ending, "FAIL"]);
	});

	test("a failing ROLLBACK does not hide the original error", async () =>
	{
		const { sql } = createFakeSql([
			{ pattern: /^FAIL/, result: () => Promise.reject(new Error("original")) },
			{ pattern: /^ROLLBACK/, result: () => Promise.reject(new Error("rollback failed")) },
		]);

		await expect(runStatements(sql, ["BEGIN", "FAIL"])).rejects.toThrow(/^original/);
	});

	test("lock_timeout (55P03) gets an explanation that nothing was changed", async () =>
	{
		const { sql } = createFakeSql([{
			pattern: /^ALTER/,
			result: () => Promise.reject(Object.assign(new Error("canceling statement due to lock timeout"), { code: "55P03" })),
		}]);

		const error = await runStatements(sql, ["ALTER TABLE t ADD COLUMN c int"]).then(() => null, (err) => err);

		expect(error.message).toContain("canceling statement due to lock timeout (while running: ALTER TABLE t ADD COLUMN c int)");
		expect(error.message).toContain("lock_timeout was reached");
		expect(error.message).toContain("run the script again");
	});

	test("validates its arguments", async () =>
	{
		await expect(runStatements({}, [])).rejects.toThrow(TypeError);
		await expect(runStatements(createFakeSql().sql, "SELECT 1")).rejects.toThrow(TypeError);
	});
});

describe("indexState", () =>
{
	test("reports missing, valid and invalid indexes", async () =>
	{
		expect(await indexState(createFakeSql().sql, "idx")).toBe("missing");
		expect(await indexState(createFakeSql([{ pattern: /pg_index/, result: [{ valid: true }] }]).sql, "idx")).toBe("valid");
		expect(await indexState(createFakeSql([{ pattern: /pg_index/, result: [{ valid: false }] }]).sql, "idx")).toBe("invalid");
	});

	test("passes the index name as a bound value and looks in the current schema", async () =>
	{
		const { sql, log } = createFakeSql();

		await indexState(sql, "orders_archived_at_idx");

		expect(log).toHaveLength(1);
		expect(log[0].values).toEqual(["orders_archived_at_idx"]);
		expect(log[0].text).toContain("current_schema()");
	});

	test("rejects an empty or non-string name", async () =>
	{
		await expect(indexState(createFakeSql().sql, "")).rejects.toThrow(TypeError);
		await expect(indexState(createFakeSql().sql, undefined)).rejects.toThrow(TypeError);
	});
});

describe("dropInvalidIndex", () =>
{
	test("drops an invalid index concurrently", async () =>
	{
		const { sql, texts } = createFakeSql([{ pattern: /pg_index/, result: [{ valid: false }] }]);

		await dropInvalidIndex(sql, "broken_idx");

		expect(texts().at(-1)).toBe("DROP INDEX CONCURRENTLY IF EXISTS \"broken_idx\"");
	});

	test("leaves valid and missing indexes alone", async () =>
	{
		const valid = createFakeSql([{ pattern: /pg_index/, result: [{ valid: true }] }]);
		const missing = createFakeSql();

		await dropInvalidIndex(valid.sql, "ok_idx");
		await dropInvalidIndex(missing.sql, "gone_idx");

		expect(valid.texts().some((text) => text.startsWith("DROP"))).toBe(false);
		expect(missing.texts().some((text) => text.startsWith("DROP"))).toBe(false);
	});

	test("quotes the name so a double quote cannot end the identifier", async () =>
	{
		const { sql, texts } = createFakeSql([{ pattern: /pg_index/, result: [{ valid: false }] }]);

		await dropInvalidIndex(sql, "a\"; DROP TABLE orders; --");

		expect(texts().at(-1)).toBe("DROP INDEX CONCURRENTLY IF EXISTS \"a\"\"; DROP TABLE orders; --\"");
	});
});

describe("withMigrationLock", () =>
{
	test("holds the advisory lock around fn and returns its result", async () =>
	{
		const { sql, log } = createFakeSql([{ pattern: /pg_try_advisory_lock/, result: [{ locked: true }] }]);
		let ranBetween = null;

		const result = await withMigrationLock(sql, async () =>
		{
			ranBetween = log.map((entry) => entry.text);

			return "done";
		});

		expect(result).toBe("done");
		expect(ranBetween).toHaveLength(1);
		expect(ranBetween[0]).toContain("pg_try_advisory_lock");
		expect(log).toHaveLength(2);
		expect(log[1].text).toContain("pg_advisory_unlock");
		expect(log[1].values).toEqual(log[0].values);
	});

	test("fails at once, without running fn or unlocking, when another migration holds the lock", async () =>
	{
		const { sql, log } = createFakeSql([{ pattern: /pg_try_advisory_lock/, result: [{ locked: false }] }]);
		let ran = false;

		await expect(withMigrationLock(sql, async () =>
		{
			ran = true;
		})).rejects.toThrow(/Another migration is running/);

		expect(ran).toBe(false);
		expect(log).toHaveLength(1);
	});

	test("unlocks and rethrows when fn fails", async () =>
	{
		const { sql, texts } = createFakeSql([{ pattern: /pg_try_advisory_lock/, result: [{ locked: true }] }]);

		await expect(withMigrationLock(sql, async () =>
		{
			throw new Error("migration failed");
		})).rejects.toThrow("migration failed");

		expect(texts().at(-1)).toContain("pg_advisory_unlock");
	});

	test("a failing unlock does not hide fn's result", async () =>
	{
		const { sql } = createFakeSql([
			{ pattern: /pg_try_advisory_lock/, result: [{ locked: true }] },
			{ pattern: /pg_advisory_unlock/, result: () => Promise.reject(new Error("connection closed")) },
		]);

		expect(await withMigrationLock(sql, async () => 42)).toBe(42);
	});

	test("rejects a non-function", async () =>
	{
		await expect(withMigrationLock(createFakeSql().sql, "nope")).rejects.toThrow(TypeError);
	});
});
