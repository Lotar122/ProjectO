// Stand-in for projecto-compress, used by tests/native-compressor.test.mjs.
// Run as: <bun> fake-compressor.mjs <scenario> compress --codec ... --input ...
//   --output ... --input-size ... [--memory-budget-mib ...] [--threads 0..64]
//   [--watch-stdin 0|1]
//
// --watch-stdin 1 works like in the real binary (default off): once stdin
// reaches EOF, whatever the behavior, the output this run created is removed
// and the fake exits 3. --threads is checked like in the real binary (exit 2
// outside 0 to 64) and reported as "workers" in zstd result lines (0 below 2,
// as for a single-threaded run; br always reports 0).
//
// <scenario> is either one behavior for both codecs or "zstd=<b>,br=<b>".
// Behaviors:
//   ok            real compression (zlib), valid result line
//   size=<n>      writes n zero bytes and reports them (picks the winner)
//   progress      two progress lines, then ok
//   slow          waits 200 ms, then ok (gives a stdin watch time to fire)
//   sigkill       writes a partial output, then SIGKILLs itself
//   exit<n>       writes a partial output, prints a result error, exits n
//                 (4: memory_budget, 70: internal "out of memory", else codec)
//   malformed     prints a line that is not JSON, exits 0
//   noresult      exits 0 without a result line
//   huge          prints more than 64 KiB on stdout
//   longline      prints one line over 4 KiB
//   wrongsize     valid output, but outputSize is off by one
//   wrongcodec    result line names the other codec
//   wronginput    inputSize is off by one
//   unsafeint     outputSize is not a safe integer
//   badworkers    workers is negative
//   afterresult   prints a line after the result line
//   okfalse       result line with ok:false, but exit 0
//   unknowntype   prints a line with an unknown type
//   badprogress   prints a progress line with a negative counter
//   splitresult   valid result line written in two chunks, with a pause between
//   nonewline     valid result line without the trailing newline
//   hang          writes a partial output, prints progress, then waits forever
//   hang-ignore   like hang, but ignores SIGTERM (the progress line means the handler is installed)
//   hang-deaf     like hang-ignore, and never reacts to stdin EOF (a binary stuck in a syscall)
//   argv=<file>   writes argv as JSON to <file> (no commas in the path), then ok
//   dump          prints argv and env keys as JSON on stderr, exits 5
//   stderr        writes 40 KiB of numbered lines to stderr, exits 5
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import zlib from "node:zlib";

const [scenario, command, ...rest] = process.argv.slice(2);
const args = {};

for (let i = 0; i < rest.length; i += 2)
{
	args[rest[i].replace(/^--/, "")] = rest[i + 1];
}

if (command !== "compress" || !args.codec || !args.input || !args.output)
{
	process.stderr.write("fake-compressor: bad arguments\n");
	process.exit(2);
}

const behaviors = Object.fromEntries(scenario.includes("=") && /^(zstd|br)=/.test(scenario)
	? scenario.split(",").map((part) => part.split(/=(.*)/s).slice(0, 2))
	: [["zstd", scenario], ["br", scenario]]);
const behavior = behaviors[args.codec] ?? "ok";
const inputSize = Number(args["input-size"]);
const emit = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const start = { type: "start", codec: args.codec, estimatedBytes: null, budgetBytes: Number(args["memory-budget-mib"]) * 1048576 };
let createdOutput = false;

function writeOutput(data, options)
{
	writeFileSync(args.output, data, options);
	createdOutput = true;
}

if (args["watch-stdin"] !== undefined && args["watch-stdin"] !== "0" && args["watch-stdin"] !== "1")
{
	process.stderr.write("fake-compressor: --watch-stdin must be 0 or 1\n");
	process.exit(2);
}

if (args.threads !== undefined && !(/^\d+$/.test(args.threads) && Number(args.threads) <= 64))
{
	process.stderr.write("fake-compressor: --threads must be between 0 and 64\n");
	process.exit(2);
}

const threads = Number(args.threads ?? 4);
const workers = args.codec === "zstd" && threads >= 2 ? threads : 0;

if (args["watch-stdin"] === "1" && behavior !== "hang-deaf")
{
	// Like the real binary: EOF means the parent is gone or wants a stop. Only
	// a file this run created is removed.
	const onEof = () =>
	{
		if (createdOutput)
		{
			rmSync(args.output, { force: true });
		}

		emit({ type: "result", ok: false, error: "io", message: "stdin reached end of file" });
		process.exit(3);
	};

	process.stdin.on("end", onEof);
	process.stdin.on("close", onEof);
	process.stdin.on("error", onEof);
	process.stdin.resume();
}

function realOutput()
{
	const data = readFileSync(args.input);

	return args.codec === "zstd" ? zlib.zstdCompressSync(data) : zlib.brotliCompressSync(data);
}

function result(output, overrides = {})
{
	return { type: "result", ok: true, codec: args.codec, inputSize, outputSize: output.length, peakBytes: 1048576, workers, elapsedMs: 5, encoder: `fake-compressor/1 ${args.codec}`, ...overrides };
}

function fail(code, error, message)
{
	writeOutput(Buffer.alloc(10));
	emit({ type: "result", ok: false, error, message });
	process.exit(code);
}

emit(start);

if (behavior === "splitresult" || behavior === "nonewline")
{
	const output = realOutput();
	const line = JSON.stringify(result(output));

	writeOutput(output, { flag: "wx" });

	if (behavior === "nonewline")
	{
		process.stdout.write(line);
	}
	else
	{
		process.stdout.write(line.slice(0, 20));
		await new Promise((resolve) => setTimeout(resolve, 100));
		process.stdout.write(`${line.slice(20)}\n`);
	}

	process.exit(0);
}

if (behavior.startsWith("argv="))
{
	writeFileSync(behavior.slice(5), JSON.stringify(process.argv.slice(2)));
}

if (behavior === "ok" || behavior === "progress" || behavior === "slow" || behavior.startsWith("size=") || behavior.startsWith("argv="))
{
	if (behavior === "slow")
	{
		await new Promise((resolve) => setTimeout(resolve, 200));
	}

	const output = behavior.startsWith("size=") ? Buffer.alloc(Number(behavior.slice(5))) : realOutput();

	writeOutput(output, { flag: "wx" });

	if (behavior === "progress")
	{
		emit({ type: "progress", read: Math.floor(inputSize / 2), written: Math.floor(output.length / 2) });
		emit({ type: "progress", read: inputSize, written: output.length });
	}

	emit(result(output));
	process.exit(0);
}

if (behavior === "sigkill")
{
	writeOutput(Buffer.alloc(10));
	process.kill(process.pid, "SIGKILL");
	await new Promise(() =>
	{});
}
else if (/^exit\d+$/.test(behavior))
{
	const code = Number(behavior.slice(4));
	const error = { 4: "memory_budget", 70: "internal" }[code] ?? "codec";

	fail(code, error, code === 70 ? "out of memory" : `fake ${error} failure`);
}
else if (behavior === "malformed")
{
	writeOutput(Buffer.alloc(10));
	process.stdout.write("this is not json\n");
}
else if (behavior === "noresult")
{
	writeOutput(Buffer.alloc(10));
}
else if (behavior === "okfalse")
{
	writeOutput(Buffer.alloc(10));
	emit({ type: "result", ok: false, error: "codec", message: "failed but exited 0" });
}
else if (behavior === "unknowntype")
{
	writeOutput(Buffer.alloc(10));
	emit({ type: "weird" });
}
else if (behavior === "badprogress")
{
	writeOutput(Buffer.alloc(10));
	emit({ type: "progress", read: -1, written: 0 });
}
else if (behavior === "huge")
{
	// Valid progress lines under 4 KiB each, so only the total size cap can
	// trip, however the pipe splits the output into chunks.
	writeOutput(Buffer.alloc(10));
	process.stdout.write(`${JSON.stringify({ type: "progress", read: 1, written: 1, pad: "x".repeat(1000) })}\n`.repeat(80));
}
else if (behavior === "longline")
{
	writeOutput(Buffer.alloc(10));
	emit({ type: "progress", read: 1, written: 1, pad: "x".repeat(5000) });
}
else if (["wrongsize", "wrongcodec", "wronginput", "unsafeint", "badworkers", "afterresult"].includes(behavior))
{
	const output = realOutput();
	const overrides = {
		wrongsize: { outputSize: output.length + 1 },
		wrongcodec: { codec: args.codec === "zstd" ? "br" : "zstd" },
		wronginput: { inputSize: inputSize + 1 },
		unsafeint: { outputSize: 2 ** 60 },
		badworkers: { workers: -1 },
		afterresult: {},
	}[behavior];

	writeOutput(output, { flag: "wx" });
	emit(result(output, overrides));

	if (behavior === "afterresult")
	{
		emit({ type: "progress", read: 1, written: 1 });
	}
}
else if (behavior === "hang" || behavior === "hang-ignore" || behavior === "hang-deaf")
{
	if (behavior !== "hang")
	{
		process.on("SIGTERM", () =>
		{});
	}

	writeOutput(Buffer.alloc(10));
	emit({ type: "progress", read: 1, written: 1 });
	setInterval(() =>
	{}, 1000);
	await new Promise(() =>
	{});
}
else if (behavior === "dump")
{
	writeOutput(Buffer.alloc(10));
	process.stderr.write(JSON.stringify({ argv: process.argv.slice(2), env: Object.keys(process.env) }));
	process.exit(5);
}
else if (behavior === "stderr")
{
	writeOutput(Buffer.alloc(10));

	for (let i = 0; i < 4000; i++)
	{
		process.stderr.write(`line ${String(i).padStart(5, "0")} padding\n`);
	}

	process.exit(5);
}
else
{
	process.stderr.write(`fake-compressor: unknown behavior ${behavior}\n`);
	process.exit(2);
}

// The behaviors above that fall through end here with exit 0. A stdin watch
// would keep the process alive while the parent holds the pipe open, so the
// process exits explicitly, once stdout has drained.
await new Promise((resolve) => process.stdout.write("", resolve));
process.exit(0);
