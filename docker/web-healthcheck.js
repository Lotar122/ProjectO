#!/usr/bin/env bun
// Docker HEALTHCHECK for docker/web-supervised.Dockerfile. Exit 0 when:
// - GET /api/ping on the local Next.js server answers 2xx within 5 s, and
// - with ARCHIVER_MODE=embedded, the supervised archiver worker has written its
//   liveness file recently (worker/archiver/liveness.js), so a crash-looping or
//   hung worker makes the container unhealthy too.
// Exit 1 otherwise, with one line on stderr saying which check failed.

import { LIVENESS_MAX_AGE_MS_DEFAULT, isLivenessFresh } from "../worker/archiver/liveness.js";

const PING_TIMEOUT_MS = 5_000;

async function checkWeb()
{
	const port = process.env.PORT || "3000";
	const response = await fetch(`http://127.0.0.1:${port}/api/ping`, {
		redirect: "manual",
		signal: AbortSignal.timeout(PING_TIMEOUT_MS),
	});

	if (!response.ok)
	{
		throw new Error(`web: /api/ping answered ${response.status}`);
	}
}

async function checkArchiver()
{
	if (process.env.ARCHIVER_MODE !== "embedded")
	{
		return;
	}

	const filePath = process.env.ARCHIVER_LIVENESS_FILE;
	const rawMaxAge = process.env.ARCHIVER_LIVENESS_MAX_AGE_MS;
	const maxAgeMs = rawMaxAge ? Number(rawMaxAge) : LIVENESS_MAX_AGE_MS_DEFAULT;

	if (!filePath)
	{
		throw new Error("archiver: ARCHIVER_LIVENESS_FILE is not set");
	}

	if (!(await isLivenessFresh(filePath, { maxAgeMs })))
	{
		throw new Error(`archiver: no worker heartbeat in the last ${maxAgeMs} ms`);
	}
}

try
{
	await checkWeb();
	await checkArchiver();
	process.exit(0);
}
catch (err)
{
	console.error(`health check failed: ${err.message}`);
	process.exit(1);
}
