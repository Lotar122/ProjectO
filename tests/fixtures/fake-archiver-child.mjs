// Stand-in for worker/archiver/main.js, used by tests/archiver-supervisor.test.mjs.
// Run as: <bun> fake-archiver-child.mjs   (behavior from FAKE_SCENARIO)
//   run          stays alive, exits 0 on SIGTERM
//   crash        exits 1 right away
//   ignore-term  stays alive and ignores SIGTERM (needs SIGKILL)
//   watch-stdin  stays alive, exits 0 when stdin closes (uses worker/archiver/parentWatch.js)
//   grandchild-crash        starts a long-running grandchild (like a compressor), then exits 1
//   grandchild-ignore-term  starts a grandchild, then behaves like ignore-term
// Every start appends "<pid> <ARCHIVER_SUPERVISED> <timestamp ms>" to FAKE_LOG; a grandchild's
// pid goes to FAKE_GRANDCHILD_LOG.
import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
import { stopOnParentGone } from "../../worker/archiver/parentWatch.js";

const scenario = process.env.FAKE_SCENARIO || "run";

if (process.env.FAKE_LOG)
{
	appendFileSync(process.env.FAKE_LOG, `${process.pid} ${process.env.ARCHIVER_SUPERVISED} ${Date.now()}\n`);
}

if (scenario.startsWith("grandchild-"))
{
	// Same process group as this process; ignores SIGTERM like the real binary did.
	const grandchild = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"], {
		stdio: "ignore",
	});

	appendFileSync(process.env.FAKE_GRANDCHILD_LOG, `${grandchild.pid}\n`);
	await new Promise((resolve) => setTimeout(resolve, 100));

	if (scenario === "grandchild-crash")
	{
		process.exit(1);
	}
}

if (scenario === "crash")
{
	process.exit(1);
}

if (scenario === "ignore-term" || scenario === "grandchild-ignore-term")
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
