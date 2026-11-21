#!/usr/bin/env bun
// Archiver worker entry: bun --conditions react-server worker/archiver/main.js
// (package.json "worker:archiver"; also spawned by the web server when
// ARCHIVER_MODE=embedded, see archiverSupervisor.js). Reads and checks its configuration, wires
// the worker to Postgres, MinIO and projecto-compress, and stops gracefully on
// SIGTERM / SIGINT (phases-bugfix/phase4.md 9.6): the running compressor is
// aborted, the job ends as "interrupted", the lock is released, exit code 0.

import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createLogger } from "@/app/lib/logger";
import { isPipe, stopOnParentGone } from "./parentWatch.js";
import { readStopDeadlineMs, runUntilStopped } from "./shutdown.js";

const log = createLogger("archiver-worker");

// Checked before the database and S3 modules load. Only names are ever logged.
const REQUIRED_ENV = ["DB_URL", "MINIO_ENDPOINT", "MINIO_ACCESS_KEY", "MINIO_SECRET_KEY"];

// Every graceful stop (signal, parent gone, fatal error) gets this long, then
// the process exits 1 anyway. Derived from ARCHIVER_STOP_GRACE_MS and strictly
// shorter than it (shutdown.js), so the exit beats the supervisor's SIGKILL.
// Exiting closes the lock connection (releasing the lock) and the compressor's
// stdin pipe. Set from the environment in main(); the default covers a fatal
// error before that.
let stopDeadlineMs = readStopDeadlineMs({});
let worker = null;
let fatal = false;
let deadlineArmed = false;

// Unref'd, so a stop that finishes in time exits normally.
function armStopDeadline()
{
	if (deadlineArmed)
	{
		return;
	}

	deadlineArmed = true;
	setTimeout(() =>
	{
		log.error(`The worker did not stop within ${stopDeadlineMs} ms; exiting`);
		process.exit(1);
	}, stopDeadlineMs).unref();
}

// An uncaught exception or unhandled rejection leaves the process in an unknown
// state: stop the worker gracefully (the job ends as "interrupted" and the lock
// is released), then exit 1 so the container restarts.
function onFatal(kind, err)
{
	if (fatal)
	{
		log.error(`${kind} while stopping`, err);
		return;
	}

	fatal = true;
	log.error(`${kind}; stopping the worker`, err);
	armStopDeadline();

	if (!worker)
	{
		process.exit(1);
	}

	worker.stop();
}

// ARCHIVER_LIVENESS_FILE (docker/*.Dockerfile, read by healthcheck.js), or null.
function readLivenessFile()
{
	const value = process.env.ARCHIVER_LIVENESS_FILE;

	if (!value)
	{
		return null;
	}

	if (!path.isAbsolute(value))
	{
		throw new Error("ARCHIVER_LIVENESS_FILE must be an absolute path");
	}

	return value;
}

process.on("uncaughtException", (err) => onFatal("Uncaught exception", err));
process.on("unhandledRejection", (reason) => onFatal("Unhandled rejection", reason));

async function main()
{
	const missing = REQUIRED_ENV.filter((name) => !process.env[name]);

	if (missing.length > 0)
	{
		throw new Error(`Missing environment variable(s): ${missing.join(", ")}`);
	}

	stopDeadlineMs = readStopDeadlineMs();

	const [{ DB }, { createS3Client }, { nativeCompressBest, readCompressorConfig }, { createArchiveWorker }, { readCompressorVersion }] =
		await Promise.all([
			import("@/app/lib/db"),
			import("@/app/server-functions/MinIO/createS3Client"),
			import("@/app/server-functions/orders/nativeCompressor"),
			import("./archiveWorker.js"),
			import("./compressorVersion.js"),
		]);

	// Refuses to start on a bad COMPRESSOR_MEMORY_BUDGET_MIB / COMPRESSOR_TIMEOUT_MS /
	// PROJECTO_ZSTD_THREADS or a missing binary, before any job could run.
	const { memoryBudgetMib, timeoutMs, zstdThreads } = readCompressorConfig();
	const binPath = process.env.PROJECTO_COMPRESSOR_BIN;
	const compressorVersion = await readCompressorVersion({ binPath });
	const version = `${process.env.ARCHIVER_VERSION || "dev"} / ${compressorVersion}`;
	const workerId = process.env.ARCHIVER_WORKER_ID || `${os.hostname()}:${process.pid}`;
	const livenessFile = readLivenessFile();
	const s3 = await createS3Client();

	// A file left by an earlier run must not count as a heartbeat of this one.
	if (livenessFile)
	{
		await rm(livenessFile, { force: true });
	}

	worker = createArchiveWorker({
		sql: DB,
		s3,
		workerId,
		version,
		livenessFile,
		compress: (srcPath, options) => nativeCompressBest(srcPath, { ...options, binPath, memoryBudgetMib, timeoutMs, zstdThreads }),
	});

	const onSignal = (signal) =>
	{
		log.info(`Received ${signal}; stopping after the current file`);
		armStopDeadline();
		worker.stop();
	};

	process.on("SIGTERM", onSignal);
	process.on("SIGINT", onSignal);

	// Started by the web server (ARCHIVER_MODE=embedded): the stdin pipe closes
	// when the web process is gone, so stop like on SIGTERM and never linger as
	// an orphan holding the lock. Only a real pipe says anything about the
	// parent; a /dev/null stdin would read as EOF at once and stop every start.
	if (process.env.ARCHIVER_SUPERVISED === "1")
	{
		if (isPipe(0))
		{
			stopOnParentGone(process.stdin, () => onSignal("parent exit (stdin closed)"));
		}
		else
		{
			log.warn("ARCHIVER_SUPERVISED=1 but stdin is not a pipe; not watching for the parent's exit");
		}
	}

	log.info(`Archiver worker ${workerId} starting (${version}; budget ${memoryBudgetMib} MiB, timeout ${timeoutMs} ms, zstd threads ${zstdThreads})`);

	// Waits for stop() too, so the worker row is removed before the pool closes.
	await runUntilStopped(worker, DB);

	log.info(`Archiver worker ${workerId} stopped${fatal ? " after a fatal error" : ""}`);
}

try
{
	await main();
	process.exit(fatal ? 1 : 0);
}
catch (err)
{
	log.error(`Archiver worker could not start: ${err.message}`);
	process.exit(1);
}
