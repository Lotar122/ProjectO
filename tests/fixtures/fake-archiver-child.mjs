// Stand-in for worker/archiver/main.js, used by tests/archiver-supervisor.test.mjs.
// Run as: <bun> fake-archiver-child.mjs   (behavior from FAKE_SCENARIO)
//   run          stays alive, exits 0 on SIGTERM
//   crash        exits 1 right away
//   ignore-term  stays alive and ignores SIGTERM (needs SIGKILL)
//   watch-stdin  stays alive, exits 0 when stdin closes (uses worker/archiver/parentWatch.js)
// Every start appends "<pid> <ARCHIVER_SUPERVISED> <timestamp ms>" to FAKE_LOG.
import { appendFileSync } from "node:fs";
import { stopOnParentGone } from "../../worker/archiver/parentWatch.js";

const scenario = process.env.FAKE_SCENARIO || "run";

if (process.env.FAKE_LOG)
{
	appendFileSync(process.env.FAKE_LOG, `${process.pid} ${process.env.ARCHIVER_SUPERVISED} ${Date.now()}\n`);
}

if (scenario === "crash")
{
	process.exit(1);
}

if (scenario === "ignore-term")
{
	process.on("SIGTERM", () => undefined);
}
else if (scenario === "watch-stdin")
{
	stopOnParentGone(process.stdin, () => process.exit(0));
}
else
{
	process.on("SIGTERM", () => process.exit(0));
}

setInterval(() => undefined, 1000);
