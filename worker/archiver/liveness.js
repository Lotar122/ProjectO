// Liveness file for the Docker HEALTHCHECK (docker/*.Dockerfile). The worker
// rewrites it after every successful heartbeat; healthcheck.js reports the
// worker unhealthy once it is older than the allowed age. Bun-only, like the
// rest of the worker.

export const LIVENESS_MAX_AGE_MS_DEFAULT = 60_000;

/**
 * Writes the current time to the liveness file, which also updates its mtime.
 *
 * @param {string} filePath Absolute path.
 * @returns {Promise<void>}
 */
export async function touchLivenessFile(filePath)
{
	if (typeof filePath !== "string" || filePath === "")
	{
		throw new TypeError("filePath must be a non-empty string");
	}

	await Bun.write(filePath, `${new Date().toISOString()}\n`);
}

/**
 * Whether the liveness file exists and was written within maxAgeMs.
 *
 * @param {string} filePath
 * @param {object} [options]
 * @param {number} [options.maxAgeMs] Default 60 s (six missed 10 s heartbeats).
 * @param {number} [options.now] Current time in ms (tests).
 * @returns {Promise<boolean>}
 */
export async function isLivenessFresh(filePath, { maxAgeMs = LIVENESS_MAX_AGE_MS_DEFAULT, now = Date.now() } = {})
{
	if (typeof filePath !== "string" || filePath === "")
	{
		throw new TypeError("filePath must be a non-empty string");
	}

	if (!Number.isSafeInteger(maxAgeMs) || maxAgeMs < 1)
	{
		throw new RangeError("maxAgeMs must be a positive integer");
	}

	const file = Bun.file(filePath);

	if (!(await file.exists()))
	{
		return false;
	}

	return now - file.lastModified <= maxAgeMs;
}
