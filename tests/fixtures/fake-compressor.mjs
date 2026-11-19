// Stand-in for projecto-compress, used by tests/native-compressor.test.mjs.
// Run as: <bun> fake-compressor.mjs <scenario> compress --codec ... --input ...
//   --output ... --input-size ... [--memory-budget-mib ...]
//
// <scenario> is either one behavior for both codecs or "zstd=<b>,br=<b>".
// Behaviors:
//   ok            real compression (zlib), valid result line
//   size=<n>      writes n zero bytes and reports them (picks the winner)
//   progress      two progress lines, then ok
//   sigkill       writes a partial output, then SIGKILLs itself
//   exit<n>       writes a partial output, prints a result error, exits n
//   malformed     prints a line that is not JSON, exits 0
//   noresult      exits 0 without a result line
//   huge          prints more than 64 KiB on stdout
//   longline      prints one line over 4 KiB
//   wrongsize     valid output, but outputSize is off by one
//   wrongcodec    result line names the other codec
//   wronginput    inputSize is off by one
//   unsafeint     outputSize is not a safe integer
//   afterresult   prints a line after the result line
//   okfalse       result line with ok:false, but exit 0
//   unknowntype   prints a line with an unknown type
//   badprogress   prints a progress line with a negative counter
//   splitresult   valid result line written in two chunks, with a pause between
//   nonewline     valid result line without the trailing newline
//   hang          writes a partial output, prints progress, then waits forever
//   hang-ignore   like hang, but ignores SIGTERM (the progress line means the handler is installed)
//   dump          prints argv and env keys as JSON on stderr, exits 5
//   stderr        writes 40 KiB of numbered lines to stderr, exits 5
import { readFileSync, writeFileSync } from "node:fs";
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

function realOutput()
{
	const data = readFileSync(args.input);

	return args.codec === "zstd" ? zlib.zstdCompressSync(data) : zlib.brotliCompressSync(data);
}

function result(output, overrides = {})
{
	return { type: "result", ok: true, codec: args.codec, inputSize, outputSize: output.length, peakBytes: 1048576, elapsedMs: 5, encoder: `fake-compressor/1 ${args.codec}`, ...overrides };
}

function fail(code, error, message)
{
	writeFileSync(args.output, Buffer.alloc(10));
	emit({ type: "result", ok: false, error, message });
	process.exit(code);
}

emit(start);

if (behavior === "splitresult" || behavior === "nonewline")
{
	const output = realOutput();
	const line = JSON.stringify(result(output));

	writeFileSync(args.output, output, { flag: "wx" });

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

if (behavior === "ok" || behavior === "progress" || behavior.startsWith("size="))
{
	const output = behavior.startsWith("size=") ? Buffer.alloc(Number(behavior.slice(5))) : realOutput();

	writeFileSync(args.output, output, { flag: "wx" });

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
	writeFileSync(args.output, Buffer.alloc(10));
	process.kill(process.pid, "SIGKILL");
	await new Promise(() =>
	{});
}
else if (/^exit\d+$/.test(behavior))
{
	const code = Number(behavior.slice(4));

	fail(code, code === 4 ? "memory_budget" : "codec", `fake ${code === 4 ? "memory_budget" : "codec"} failure`);
}
else if (behavior === "malformed")
{
	writeFileSync(args.output, Buffer.alloc(10));
	process.stdout.write("this is not json\n");
}
else if (behavior === "noresult")
{
	writeFileSync(args.output, Buffer.alloc(10));
}
else if (behavior === "okfalse")
{
	writeFileSync(args.output, Buffer.alloc(10));
	emit({ type: "result", ok: false, error: "codec", message: "failed but exited 0" });
}
else if (behavior === "unknowntype")
{
	writeFileSync(args.output, Buffer.alloc(10));
	emit({ type: "weird" });
}
else if (behavior === "badprogress")
{
	writeFileSync(args.output, Buffer.alloc(10));
	emit({ type: "progress", read: -1, written: 0 });
}
else if (behavior === "huge")
{
	writeFileSync(args.output, Buffer.alloc(10));
	process.stdout.write(`${"x".repeat(1023)}\n`.repeat(80));
}
else if (behavior === "longline")
{
	writeFileSync(args.output, Buffer.alloc(10));
	emit({ type: "progress", read: 1, written: 1, pad: "x".repeat(5000) });
}
else if (["wrongsize", "wrongcodec", "wronginput", "unsafeint", "afterresult"].includes(behavior))
{
	const output = realOutput();
	const overrides = {
		wrongsize: { outputSize: output.length + 1 },
		wrongcodec: { codec: args.codec === "zstd" ? "br" : "zstd" },
		wronginput: { inputSize: inputSize + 1 },
		unsafeint: { outputSize: 2 ** 60 },
		afterresult: {},
	}[behavior];

	writeFileSync(args.output, output, { flag: "wx" });
	emit(result(output, overrides));

	if (behavior === "afterresult")
	{
		emit({ type: "progress", read: 1, written: 1 });
	}
}
else if (behavior === "hang" || behavior === "hang-ignore")
{
	if (behavior === "hang-ignore")
	{
		process.on("SIGTERM", () =>
		{});
	}

	writeFileSync(args.output, Buffer.alloc(10));
	emit({ type: "progress", read: 1, written: 1 });
	setInterval(() =>
	{}, 1000);
	await new Promise(() =>
	{});
}
else if (behavior === "dump")
{
	writeFileSync(args.output, Buffer.alloc(10));
	process.stderr.write(JSON.stringify({ argv: process.argv.slice(2), env: Object.keys(process.env) }));
	process.exit(5);
}
else if (behavior === "stderr")
{
	writeFileSync(args.output, Buffer.alloc(10));

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
