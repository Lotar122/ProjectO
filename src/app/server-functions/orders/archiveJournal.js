import "server-only";

// SQL for the archiver's crash journal, archive_pending_verify
// (db/migrations/2026-11-19_archive_jobs.sql, phases-bugfix/phase4.md 9.2 and
// 9.3): one row per file whose original is being (or was) replaced and whose
// read-back has not passed yet. Every function takes the postgres.js client as
// `sql` and returns the bare query; callers bound it with withTimeout, like the
// other job queries.
//
// 'needs_attention' rows are never changed or removed from here except by
// markPendingNeedsAttention: deletePendingVerify and markPendingUploaded skip
// them, so a row an operator has to look at never disappears automatically.

/**
 * @typedef {object} PendingVerifyEntry
 * @property {string} fileId
 * @property {string | number} jobId
 * @property {"zstd" | "br"} method
 * @property {string} originalSha256
 * @property {number} originalSize
 * @property {number} storedSize
 * @property {string} preUploadEtag ETag the replacing upload used for If-Match.
 * @property {string} originalPath The verified original in the temp directory.
 */

/**
 * Opens the journal row before the replacing upload (state 'uploading'). A
 * row that already exists for the file makes this fail (primary key), so a
 * file with an unresolved row is never replaced again.
 *
 * @param {Function} sql
 * @param {PendingVerifyEntry} entry
 * @returns {Promise<unknown>}
 */
export function insertPendingVerify(sql, entry)
{
	return sql`
		INSERT INTO archive_pending_verify
			(file_id, job_id, method, original_sha256, original_size, stored_size, pre_upload_etag, original_path, state)
		VALUES (
			${entry.fileId},
			${entry.jobId},
			${entry.method},
			${entry.originalSha256},
			${entry.originalSize},
			${entry.storedSize},
			${entry.preUploadEtag},
			${entry.originalPath},
			'uploading'
		)
	`;
}

/**
 * Records that the replacing upload returned.
 *
 * @param {Function} sql
 * @param {string} fileId
 * @param {string | null} storedEtag
 * @returns {Promise<unknown>}
 */
export function markPendingUploaded(sql, fileId, storedEtag)
{
	return sql`
		UPDATE archive_pending_verify
		SET stored_etag = ${storedEtag}, state = 'uploaded', updated_at = now()
		WHERE file_id = ${fileId}
			AND state <> 'needs_attention'
		RETURNING file_id
	`;
}

/**
 * Hands the row to an operator: it is counted in the status API and never
 * processed automatically again.
 *
 * @param {Function} sql
 * @param {string} fileId
 * @param {string} note Where the original is and why the row was left.
 * @returns {Promise<unknown>}
 */
export function markPendingNeedsAttention(sql, fileId, note)
{
	return sql`
		UPDATE archive_pending_verify
		SET state = 'needs_attention', note = ${note}, updated_at = now()
		WHERE file_id = ${fileId}
		RETURNING file_id
	`;
}

/**
 * Closes the row once the file's outcome is settled. Never removes a
 * 'needs_attention' row.
 *
 * @param {Function} sql
 * @param {string} fileId
 * @returns {Promise<unknown>}
 */
export function deletePendingVerify(sql, fileId)
{
	return sql`
		DELETE FROM archive_pending_verify
		WHERE file_id = ${fileId}
			AND state <> 'needs_attention'
	`;
}

/**
 * Removes the row one archiving attempt opened, and only while nothing has
 * happened to it since: still 'uploading' and still pointing at that attempt's
 * temp original (each attempt gets a fresh path). Used when the insert landed
 * after it had already timed out, so no upload was made for the row.
 *
 * @param {Function} sql
 * @param {string} fileId
 * @param {string} originalPath The attempt's temp original.
 * @returns {Promise<unknown>}
 */
export function deletePendingVerifyAttempt(sql, fileId, originalPath)
{
	return sql`
		DELETE FROM archive_pending_verify
		WHERE file_id = ${fileId}
			AND original_path = ${originalPath}
			AND state = 'uploading'
	`;
}

/**
 * The rows crash recovery handles: every row that is not 'needs_attention'.
 * bigint columns come back as strings (postgres.js default).
 *
 * @param {Function} sql
 * @returns {Promise<object[]>}
 */
export function listPendingVerifications(sql)
{
	return sql`
		SELECT file_id, job_id, method, original_sha256, original_size, stored_size,
			pre_upload_etag, stored_etag, original_path, state
		FROM archive_pending_verify
		WHERE state IN ('uploading', 'uploaded')
		ORDER BY created_at, file_id
	`;
}

/**
 * The originals every row refers to, 'needs_attention' rows included. The temp
 * sweep keeps these files.
 *
 * @param {Function} sql
 * @returns {Promise<{ original_path: string }[]>}
 */
export function listJournalOriginalPaths(sql)
{
	return sql`
		SELECT original_path
		FROM archive_pending_verify
	`;
}

/**
 * The ids among `fileIds` that have a journal row in any state: the archiver
 * is about to replace, is replacing, or has replaced the object and not yet
 * verified it. A metadata-only change (a rename) must not run then, because
 * the archiver's write would carry the metadata it read before the change.
 * The row is inserted before the archiver's last HEAD and the upload, and
 * removed only after the read-back (or once crash recovery settles it).
 *
 * @param {Function} sql
 * @param {readonly string[]} fileIds
 * @returns {Promise<{ file_id: string }[]>}
 */
export function listJournaledFileIds(sql, fileIds)
{
	return sql`
		SELECT file_id
		FROM archive_pending_verify
		WHERE file_id = ANY(${fileIds}::text[])
	`;
}

/**
 * Whether any order still lists the file. Recovery has no order id (the
 * journal is keyed by file), so this replaces isFileOnOrder there.
 *
 * @param {Function} sql
 * @param {string} fileId
 * @returns {Promise<boolean>}
 */
export async function isFileOnAnyOrder(sql, fileId)
{
	const rows = await sql`
		SELECT 1
		FROM orders
		WHERE ${fileId} = ANY(files)
		LIMIT 1
	`;

	return rows.length > 0;
}
