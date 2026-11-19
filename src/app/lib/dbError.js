// Postgres errors carry a `detail` such as `Key (email)=(a@b.c) already
// exists.`, so a raw error object must never reach the logs (they must not
// contain emails or names). This keeps only the fields that are safe.

/**
 * One-line, PII-free description of a database error.
 *
 * @param {unknown} err
 * @returns {string}
 */
export function describeDbError(err)
{
	const code = err?.code ? `code ${err.code}` : "no code";
	const constraint = err?.constraint_name ? `, constraint ${err.constraint_name}` : "";
	const message = typeof err?.message === "string" ? err.message : "unknown error";

	return `${message} (${code}${constraint})`;
}
