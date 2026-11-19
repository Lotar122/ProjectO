#!/usr/bin/env bun
// Archiver worker entry: bun --conditions react-server worker/archiver/main.js
// (package.json "worker:archiver"; also spawned by the web server when
// ARCHIVER_MODE=embedded, see archiverSupervisor.js). Reads and checks its configuration, wires
// the worker to Postgres, MinIO and projecto-compress, and stops gracefully on
// SIGTERM / SIGINT (phases-bugfix/phase4.md 9.6): the running compressor is
// aborted, the job ends as "interrupted", the lock is released, exit code 0.

import os from "node:os";

import { createLogger } from "@/app/lib/logger";
import { stopOnParentGone } from "./parentWatch.js";

const log = createLogger("archiver-worker");

// Checked before the database and S3 modules load. Only names are ever logged.
const REQUIRED_ENV = ["DB_URL", "MINIO_ENDPOINT", "MINIO_ACCESS_KEY", "MINIO_SECRET_KEY"];
// After a fatal error the graceful stop gets this long (inside the 2 min
// stop_grace_period), then the process exits anyway.
const FATAL_EXIT_MS = 100_000;

let worker = null;
let fatal = false;

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
	setTimeout(() => process.exit(1), FATAL_EXIT_MS).unref();

	if (!worker)
	{
		process.exit(1);
	}

	worker.stop();
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

	const [{ DB }, { createS3Client }, { nativeCompressBest, readCompressorConfig }, { createArchiveWorker }, { readCompressorVersion }] =
		await Promise.all([
			import("@/app/lib/db"),
			import("@/app/server-functions/MinIO/createS3Client"),
			import("@/app/server-functions/orders/nativeCompressor"),
			import("./archiveWorker.js"),
			import("./compressorVersion.js"),
		]);

	// Refuses to start on a bad COMPRESSOR_MEMORY_BUDGET_MIB / COMPRESSOR_TIMEOUT_MS
	// or a missing binary, before any job could run.
	const { memoryBudgetMib, timeoutMs } = readCompressorConfig();
	const binPath = process.env.PROJECTO_COMPRESSOR_BIN;
	const compressorVersion = await readCompressorVersion({ binPath });
	const version = `${process.env.ARCHIVER_VERSION || "dev"} / ${compressorVersion}`;
	const workerId = process.env.ARCHIVER_WORKER_ID || `${os.hostname()}:${process.pid}`;
	const s3 = await createS3Client();

	worker = createArchiveWorker({
		sql: DB,
		s3,
		workerId,
		version,
		compress: (srcPath, options) => nativeCompressBest(srcPath, { ...options, binPath, memoryBudgetMib, timeoutMs }),
	});

	const onSignal = (signal) =>
	{
		log.info(`Received ${signal}; stopping after the current file`);
		worker.stop();
	};

	process.on("SIGTERM", onSignal);
	process.on("SIGINT", onSignal);

	// Started by the web server (ARCHIVER_MODE=embedded): the stdin pipe closes
	// when the web process is gone, so stop like on SIGTERM and never linger as
	// an orphan holding the lock.
	if (process.env.ARCHIVER_SUPERVISED === "1")
	{
		stopOnParentGone(process.stdin, () => onSignal("parent exit (stdin closed)"));
	}

	log.info(`Archiver worker ${workerId} starting (${version}; budget ${memoryBudgetMib} MiB, timeout ${timeoutMs} ms)`);

	await worker.run();
	await DB.end({ timeout: 5 });

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
