// Helpers shared by the one-time migration scripts in scripts/.
//
// The migration files are run one statement at a time on a single connection
// (the scripts use `max: 1`), not as one multi-statement string: Postgres runs
// a multi-statement simple query as one implicit transaction, and statements
// such as CREATE INDEX CONCURRENTLY refuse to run inside a transaction.

// Shared by every migration script, so two migrations never run at the same
// time. Different from the archiver's lock key (orderArchiver.js).
const MIGRATION_LOCK_KEY = "5067091845220772";
const LOCK_NOT_AVAILABLE = "55P03";

// Characters that can be part of an unquoted identifier (letters, digits,
// underscore, `$`, and any non-ASCII character).
const IDENTIFIER_CHAR = /[A-Za-z0-9_$\u0080-\uFFFF]/;

function isTransactionStart(statement)
{
	return /^(BEGIN|START\s+TRANSACTION)\b/i.test(statement);
}

function isTransactionEnd(statement)
{
	return /^(COMMIT|END|ROLLBACK|ABORT)\b/i.test(statement);
}

// Start of a dollar-quote tag. Sticky, so it is matched at an offset without
// slicing the text.
const DOLLAR_TAG = /\$(?:[A-Za-z_\u0080-\uFFFF][A-Za-z_0-9\u0080-\uFFFF]*)?\$/y;

// Index just past the block comment that starts at `start`. Postgres nests
// block comments, so `/* a /* b */ c */` is one comment.
function skipBlockComment(text, start)
{
	let depth = 1;
	let index = start + 2;

	while (index < text.length)
	{
		if (text.startsWith("/*", index))
		{
			depth++;
			index += 2;
		}
		else if (text.startsWith("*/", index))
		{
			depth--;
			index += 2;

			if (depth === 0)
			{
				return index;
			}
		}
		else
		{
			index++;
		}
	}

	return text.length;
}

// True when the `'` at `quoteIndex` opens an E'...' string, where a backslash
// escapes the next character. The E must not be the tail of a longer word.
function isEscapeString(text, quoteIndex)
{
	return quoteIndex >= 1
		&& (text[quoteIndex - 1] === "E" || text[quoteIndex - 1] === "e")
		&& (quoteIndex < 2 || !IDENTIFIER_CHAR.test(text[quoteIndex - 2]));
}

// Returns the index just past the end of the token that starts at `start`
// (a comment, a quoted string or identifier, or a dollar-quoted body), or
// `start` when no such token starts there.
function skipToken(text, start)
{
	if (text.startsWith("--", start))
	{
		const end = text.indexOf("\n", start);

		return end === -1 ? text.length : end + 1;
	}

	if (text.startsWith("/*", start))
	{
		return skipBlockComment(text, start);
	}

	const quote = text[start];

	if (quote === "'" || quote === "\"")
	{
		const backslashEscapes = quote === "'" && isEscapeString(text, start);
		let index = start + 1;

		while (index < text.length)
		{
			if (backslashEscapes && text[index] === "\\")
			{
				// A backslash escapes the next character, a quote included.
				index += 2;
				continue;
			}

			if (text[index] === quote)
			{
				// A doubled quote is an escaped quote inside the string.
				if (text[index + 1] === quote)
				{
					index += 2;
					continue;
				}

				return index + 1;
			}

			index++;
		}

		return text.length;
	}

	if (quote === "$" && !(start > 0 && IDENTIFIER_CHAR.test(text[start - 1])))
	{
		// A dollar-quote tag cannot start right after an identifier character, so
		// the `$tag$` in an identifier such as my$tag$x is not a quote start.
		DOLLAR_TAG.lastIndex = start;

		const dollarTag = DOLLAR_TAG.exec(text);

		if (dollarTag)
		{
			const end = text.indexOf(dollarTag[0], start + dollarTag[0].length);

			return end === -1 ? text.length : end + dollarTag[0].length;
		}
	}

	return start;
}

function stripComments(statement)
{
	let result = "";
	let index = 0;

	while (index < statement.length)
	{
		const next = skipToken(statement, index);

		if (next === index)
		{
			result += statement[index];
			index++;
			continue;
		}

		const token = statement.slice(index, next);

		if (token.startsWith("--"))
		{
			// The token includes its newline; keep it so the statement stays readable.
			result += token.endsWith("\n") ? "\n" : "";
		}
		else
		{
			result += token.startsWith("/*") ? " " : token;
		}
		index = next;
	}

	return result.trim();
}

/**
 * Splits a migration file into its statements. Understands `--` and (nested)
 * block comments, quoted strings and identifiers (including backslash escapes
 * in E'...' strings), and dollar-quoted bodies (DO
 * blocks), so a `;` inside any of them does not end a statement. Comments are
 * removed and empty statements are dropped.
 *
 * @param {string} text Contents of a .sql file.
 * @returns {string[]} The statements, without the trailing `;`.
 */
export function splitSqlStatements(text)
{
	if (typeof text !== "string")
	{
		throw new TypeError("splitSqlStatements: text must be a string");
	}

	const statements = [];
	let start = 0;
	let index = 0;

	while (index < text.length)
	{
		const next = skipToken(text, index);

		if (next !== index)
		{
			index = next;
			continue;
		}

		if (text[index] === ";")
		{
			statements.push(text.slice(start, index));
			start = index + 1;
		}

		index++;
	}

	statements.push(text.slice(start));

	return statements.map(stripComments).filter((statement) => statement.length > 0);
}

/**
 * Runs statements one by one on the script's single connection. When a
 * statement fails inside an explicit BEGIN ... COMMIT block, the block is
 * rolled back before the error is rethrown, so nothing of it stays applied.
 *
 * @param {import("postgres").Sql} sql Client created with `max: 1`.
 * @param {readonly string[]} statements From splitSqlStatements().
 * @returns {Promise<void>}
 */
export async function runStatements(sql, statements)
{
	if (typeof sql?.unsafe !== "function")
	{
		throw new TypeError("runStatements: sql must be a postgres client");
	}

	if (!Array.isArray(statements))
	{
		throw new TypeError("runStatements: statements must be an array");
	}

	let inTransaction = false;

	for (const statement of statements)
	{
		try
		{
			await sql.unsafe(statement);
		}
		catch (err)
		{
			if (inTransaction)
			{
				await sql.unsafe("ROLLBACK").catch(() => undefined);
			}

			const firstLine = statement.split("\n")[0];

			err.message = `${err.message} (while running: ${firstLine})`;

			if (err.code === LOCK_NOT_AVAILABLE)
			{
				err.message += ". lock_timeout was reached because another session holds a conflicting lock; nothing was changed by this statement, run the script again when the database is quieter";
			}

			throw err;
		}

		if (isTransactionStart(statement))
		{
			inTransaction = true;
		}
		else if (isTransactionEnd(statement))
		{
			inTransaction = false;
		}
	}
}

/**
 * Reports whether an index exists and whether it is valid. A CREATE INDEX
 * CONCURRENTLY that failed leaves an invalid index behind, which IF NOT EXISTS
 * would then skip.
 *
 * @param {import("postgres").Sql} sql
 * @param {string} indexName Index in the current schema.
 * @returns {Promise<"missing" | "valid" | "invalid">}
 */
export async function indexState(sql, indexName)
{
	if (typeof indexName !== "string" || !indexName)
	{
		throw new TypeError("indexState: indexName must be a non-empty string");
	}

	const rows = await sql`
		SELECT i.indisvalid AS valid
		FROM pg_index i
		JOIN pg_class c ON c.oid = i.indexrelid
		JOIN pg_namespace n ON n.oid = c.relnamespace
		WHERE n.nspname = current_schema()
			AND c.relname = ${indexName}
	`;

	if (rows.length === 0)
	{
		return "missing";
	}

	return rows[0].valid ? "valid" : "invalid";
}

/**
 * Drops an index left invalid by a failed CREATE INDEX CONCURRENTLY, without
 * blocking writes to its table, so the migration can build it again.
 *
 * @param {import("postgres").Sql} sql
 * @param {string} indexName Index in the current schema.
 * @returns {Promise<void>}
 */
export async function dropInvalidIndex(sql, indexName)
{
	if (await indexState(sql, indexName) !== "invalid")
	{
		return;
	}

	const quotedName = `"${indexName.replaceAll("\"", "\"\"")}"`;

	await sql.unsafe(`DROP INDEX CONCURRENTLY IF EXISTS ${quotedName}`);
}

/**
 * Runs `fn` while holding a session-level advisory lock shared by all
 * migration scripts. Fails at once when another migration holds it.
 *
 * @template T
 * @param {import("postgres").Sql} sql Client created with `max: 1`.
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
export async function withMigrationLock(sql, fn)
{
	if (typeof fn !== "function")
	{
		throw new TypeError("withMigrationLock: fn must be a function");
	}

	const [{ locked }] = await sql`SELECT pg_try_advisory_lock(${MIGRATION_LOCK_KEY}::bigint) AS locked`;

	if (!locked)
	{
		throw new Error("Another migration is running (its advisory lock is held); try again when it has finished");
	}

	try
	{
		return await fn();
	}
	finally
	{
		await sql`SELECT pg_advisory_unlock(${MIGRATION_LOCK_KEY}::bigint)`.catch(() => undefined);
	}
}
