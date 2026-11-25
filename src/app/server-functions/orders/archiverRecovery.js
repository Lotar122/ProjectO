import "server-only";

import path from "node:path";

/**
 * Directory where the archiver keeps originals it could not verify or restore.
 *
 * @returns {string}
 */
export function recoveryDir()
{
	return process.env.ARCHIVER_RECOVERY_DIR || path.join(process.cwd(), "archiver-recovery");
}

/**
 * Paths of the recovery copy (`<id>.orig`) and its metadata (`<id>.json`) for a file.
 * The archiver writes them with the id URI-encoded; this is the single source of that naming.
 *
 * @param {string} fileId Id of the stored file (its S3 key).
 * @returns {{ filePath: string, infoPath: string }}
 */
export function recoveryPaths(fileId)
{
	if (typeof fileId !== "string" || !fileId)
	{
		throw new TypeError("recoveryPaths: fileId must be a non-empty string");
	}

	const dir = recoveryDir();
	const baseName = encodeURIComponent(fileId);

	return {
		filePath: path.join(dir, `${baseName}.orig`),
		infoPath: path.join(dir, `${baseName}.json`),
	};
}

// The exact name createTempFilePath() gives a downloaded original.
const TEMP_ORIGINAL_NAME_PATTERN = /^projecto-archive-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * A journal row's original_path is only ever read or removed when it is an
 * archiver original: an absolute, normalized path whose name is exactly what
 * createTempFilePath() gives one. Its folder may differ from today's
 * os.tmpdir(), so a TMPDIR change between runs does not strand the row; a
 * restore still re-hashes the file against the journal first.
 *
 * @param {unknown} filePath
 * @returns {boolean}
 */
export function isTempOriginal(filePath)
{
	if (typeof filePath !== "string" || !path.isAbsolute(filePath) || path.normalize(filePath) !== filePath)
	{
		return false;
	}

	return TEMP_ORIGINAL_NAME_PATTERN.test(path.basename(filePath));
}
