#!/usr/bin/env bun
// Docker HEALTHCHECK for the archiver worker (docker/archiver-worker.Dockerfile):
// exit 0 while the liveness file the worker writes after each heartbeat is
// fresh, 1 otherwise. Stale means the worker is hung, crash-looping, or cannot
// reach Postgres.
//
//   ARCHIVER_LIVENESS_FILE          path the worker writes (required)
//   ARCHIVER_LIVENESS_MAX_AGE_MS    allowed age, default 60000

import { LIVENESS_MAX_AGE_MS_DEFAULT, isLivenessFresh } from "./liveness.js";

const filePath = process.env.ARCHIVER_LIVENESS_FILE;
const rawMaxAge = process.env.ARCHIVER_LIVENESS_MAX_AGE_MS;
const maxAgeMs = rawMaxAge ? Number(rawMaxAge) : LIVENESS_MAX_AGE_MS_DEFAULT;

try
{
	if (!filePath)
	{
		throw new Error("ARCHIVER_LIVENESS_FILE is not set");
	}

	if (!(await isLivenessFresh(filePath, { maxAgeMs })))
	{
		console.error(`archiver worker: no heartbeat in the last ${maxAgeMs} ms`);
		process.exit(1);
	}

	process.exit(0);
}
catch (err)
{
	console.error(`archiver worker health check failed: ${err.message}`);
	process.exit(1);
}
