import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { buffer } from "node:stream/consumers";
import zlib from "node:zlib";
import { createDecompressStream, createTempFilePath } from "../src/app/server-functions/orders/fileCompression.js";
import {
	NativeCompressorError,
	nativeCompressBest,
	readCompressorConfig,
} from "../src/app/server-functions/orders/nativeCompressor.js";

const FAKE_SCRIPT = path.join(import.meta.dir, "fixtures", "fake-compressor.mjs");
const REAL_BIN = process.env.PROJECTO_COMPRESSOR_BIN;

const sha = (data) => createHash("sha256").update(data).digest("hex");
const decompress = (method, data) => buffer(Readable.from([data]).pipe(createDecompressStream(method)));

// Repetitive but not trivial, like an ASCII STL scan.
function compressibleData()
{
	const lines = [];

	for (let i = 0; i < 4000; i++)
	{
		lines.push(`  facet normal ${(i % 17) / 17} ${(i % 7) / 7} 0\n    vertex ${i} ${i * 2} ${i % 13}\n  endfacet\n`);
	}

	return Buffer.from(lines.join(""));
}

// Points TMPDIR at an empty directory for the test, so the temp files the
// adapter creates can be listed before and after. The directory only holds
// the input file when fn returns, unless the test keeps a result file.
async function withInput(data, fn)
{
	const dir = await mkdtemp(path.join(os.tmpdir(), "native-compressor-test-"));
	const previous = process.env.TMPDIR;

	process.env.TMPDIR = dir;

	try
	{
		const srcPath = createTempFilePath();

		await writeFile(srcPath, data);
		await fn(srcPath, async () => (await readdir(dir)).filter((name) => name !== path.basename(srcPath)));
	}
	finally
	{
		if (previous === undefined)
		{
			delete process.env.TMPDIR;
		}
		else
		{
			process.env.TMPDIR = previous;
		}

		await rm(dir, { recursive: true, force: true });
	}
}

const fakeOptions = (scenario, extra = {}) => ({
	binPath: process.execPath,
	binArgs: [FAKE_SCRIPT, scenario],
	memoryBudgetMib: 64,
	timeoutMs: 30_000,
	...extra,
});

async function assertRejectsNative(promise, pattern)
{
	let error;

	try
	{
		await promise;
	}
	catch (err)
	{
		error = err;
	}

	assert.ok(error instanceof NativeCompressorError, `expected NativeCompressorError, got ${error}`);
	assert.match(error.message, pattern);

	return error;
}

test("keeps the smaller of the two outputs and leaves only that file behind", async () =>
{
	const data = compressibleData();

	await withInput(data, async (srcPath, leftovers) =>
	{
		const zstdWins = await nativeCompressBest(srcPath, fakeOptions("zstd=size=100,br=size=200"));

		assert.equal(zstdWins.method, "zstd");
		assert.equal(zstdWins.size, 100);
		assert.equal(zstdWins.encoder, "fake-compressor/1 zstd");
		assert.ok(zstdWins.path.endsWith(".zst"));
		assert.deepEqual(await leftovers(), [path.basename(zstdWins.path)]);
		await rm(zstdWins.path);

		const brotliWins = await nativeCompressBest(srcPath, fakeOptions("zstd=size=300,br=size=100"));

		assert.equal(brotliWins.method, "br");
		assert.equal(brotliWins.size, 100);
		assert.ok(brotliWins.path.endsWith(".br"));
		assert.deepEqual(await leftovers(), [path.basename(brotliWins.path)]);
		await rm(brotliWins.path);

		const tie = await nativeCompressBest(srcPath, fakeOptions("size=150"));

		assert.equal(tie.method, "zstd");
		assert.deepEqual(await leftovers(), [path.basename(tie.path)]);
	});
});

test("the output decodes through createDecompressStream", async () =>
{
	const data = compressibleData();

	await withInput(data, async (srcPath) =>
	{
		const result = await nativeCompressBest(srcPath, fakeOptions("ok"));

		assert.ok(result);
		assert.equal((await readFile(result.path)).length, result.size);
		assert.equal(sha(await decompress(result.method, await readFile(result.path))), sha(data));
	});
});

test("an empty file gives null without starting the binary", async () =>
{
	await withInput(Buffer.alloc(0), async (srcPath, leftovers) =>
	{
		assert.equal(await nativeCompressBest(srcPath, { binPath: "/nonexistent/projecto-compress" }), null);
		assert.deepEqual(await leftovers(), []);
	});
});

test("returns null and removes both outputs when the saving is below minSavingsRatio", async () =>
{
	await withInput(compressibleData(), async (srcPath, leftovers) =>
	{
		assert.equal(await nativeCompressBest(srcPath, fakeOptions("size=100", { minSavingsRatio: 0.9999 })), null);
		assert.deepEqual(await leftovers(), []);

		const result = await nativeCompressBest(srcPath, fakeOptions("size=100", { minSavingsRatio: 0 }));

		assert.ok(result);
		assert.ok(existsSync(result.path));
	});
});

test("exit 4 for br skips that candidate and keeps the zstd result", async () =>
{
	await withInput(compressibleData(), async (srcPath, leftovers) =>
	{
		const result = await nativeCompressBest(srcPath, fakeOptions("zstd=ok,br=exit4"));

		assert.equal(result.method, "zstd");
		assert.deepEqual(await leftovers(), [path.basename(result.path)]);
	});
});

test("exit 4 for br with a poor zstd result still returns null, not an error", async () =>
{
	await withInput(Buffer.from("x".repeat(1000)), async (srcPath, leftovers) =>
	{
		assert.equal(await nativeCompressBest(srcPath, fakeOptions("zstd=size=999,br=exit4")), null);
		assert.deepEqual(await leftovers(), []);
	});
});

test("exit 4 for zstd throws and leaves nothing behind", async () =>
{
	await withInput(compressibleData(), async (srcPath, leftovers) =>
	{
		const error = await assertRejectsNative(nativeCompressBest(srcPath, fakeOptions("exit4")), /exited with code 4.*memory/);

		assert.equal(error.exitCode, 4);
		assert.equal(error.signal, null);
		assert.deepEqual(await leftovers(), []);
	});
});

test("a br failure other than exit 4 throws and removes the finished zstd output", async () =>
{
	await withInput(compressibleData(), async (srcPath, leftovers) =>
	{
		const error = await assertRejectsNative(nativeCompressBest(srcPath, fakeOptions("zstd=ok,br=exit5")), /exited with code 5/);

		assert.equal(error.exitCode, 5);
		assert.deepEqual(await leftovers(), []);
	});
});

test("a child that SIGKILLs itself is reported as a likely OOM kill", async () =>
{
	await withInput(compressibleData(), async (srcPath, leftovers) =>
	{
		const error = await assertRejectsNative(nativeCompressBest(srcPath, fakeOptions("sigkill")), /SIGKILL.*likely OOM/);

		assert.equal(error.signal, "SIGKILL");
		assert.equal(error.exitCode, null);
		assert.deepEqual(await leftovers(), []);
	});
});

const PROTOCOL_ERRORS = [
	["malformed JSON", "malformed", /not JSON/],
	["no result line", "noresult", /no result line/],
	["oversized stdout", "huge", /stdout is larger than 65536 bytes/],
	["an oversized line", "longline", /line is larger than 4096 bytes/],
	["a wrong outputSize", "wrongsize", /outputSize/],
	["a wrong codec", "wrongcodec", /codec/],
	["a wrong inputSize", "wronginput", /inputSize/],
	["an unsafe integer", "unsafeint", /not a safe integer/],
	["a line after the result", "afterresult", /after the result/],
	["ok:false with exit 0", "okfalse", /failed result line/],
	["an unknown line type", "unknowntype", /unknown stdout line type/],
	["invalid progress counters", "badprogress", /invalid counters/],
];

for (const [name, scenario, pattern] of PROTOCOL_ERRORS)
{
	test(`protocol error: ${name} throws and removes the output`, async () =>
	{
		await withInput(compressibleData(), async (srcPath, leftovers) =>
		{
			const error = await assertRejectsNative(nativeCompressBest(srcPath, fakeOptions(scenario)), pattern);

			assert.match(error.message, /protocol error/);
			assert.deepEqual(await leftovers(), []);
		});
	});
}

test("a hanging child is killed with SIGTERM when the timeout passes", async () =>
{
	await withInput(compressibleData(), async (srcPath, leftovers) =>
	{
		const started = Date.now();
		const error = await assertRejectsNative(
			nativeCompressBest(srcPath, fakeOptions("hang", { timeoutMs: 300 })),
			/timed out after 300 ms/,
		);

		assert.equal(error.signal, "SIGTERM");
		assert.ok(Date.now() - started < 10_000);
		assert.deepEqual(await leftovers(), []);
	});
});

// The fixture prints its progress line only after the SIGTERM handler is
// installed, so aborting from onProgress cannot race the child's startup.
test("a child that ignores SIGTERM is killed with SIGKILL after the grace period", async () =>
{
	await withInput(compressibleData(), async (srcPath, leftovers) =>
	{
		const controller = new AbortController();
		let abortedAt = 0;
		const promise = nativeCompressBest(srcPath, fakeOptions("hang-ignore", {
			signal: controller.signal,
			killGraceMs: 400,
			onProgress: () =>
			{
				abortedAt ||= Date.now();
				controller.abort();
			},
		}));

		await assert.rejects(promise, (err) => err.name === "AbortError");
		assert.ok(Date.now() - abortedAt >= 350, "the child only dies after the grace period");
		assert.deepEqual(await leftovers(), []);
	});
});

test("a result line split across chunks or without a trailing newline is accepted", async () =>
{
	await withInput(compressibleData(), async (srcPath, leftovers) =>
	{
		for (const scenario of ["splitresult", "nonewline"])
		{
			const result = await nativeCompressBest(srcPath, fakeOptions(scenario));

			assert.ok(result, scenario);
			await rm(result.path);
		}

		assert.deepEqual(await leftovers(), []);
	});
});

test("a symlink source is refused before anything is spawned", async () =>
{
	await withInput(compressibleData(), async (srcPath, leftovers) =>
	{
		const linkPath = createTempFilePath();

		await symlink(srcPath, linkPath);
		await assert.rejects(nativeCompressBest(linkPath, fakeOptions("ok")), TypeError);
		assert.deepEqual(await leftovers(), [path.basename(linkPath)]);
	});
});

test("a source that does not exist throws NativeCompressorError", async () =>
{
	await withInput(compressibleData(), async (srcPath) =>
	{
		await rm(srcPath);
		await assertRejectsNative(nativeCompressBest(srcPath, fakeOptions("ok")), /source file is not readable/);
	});
});

test("a directory as source is refused", async () =>
{
	await withInput(compressibleData(), async () =>
	{
		await assert.rejects(nativeCompressBest(os.tmpdir(), fakeOptions("ok")), TypeError);
	});
});

test("an abort signal stops the child, removes the output and rejects with the abort reason", async () =>
{
	await withInput(compressibleData(), async (srcPath, leftovers) =>
	{
		const controller = new AbortController();
		const promise = nativeCompressBest(srcPath, fakeOptions("hang", {
			signal: controller.signal,
			onProgress: () => controller.abort(),
		}));

		await assert.rejects(promise, (err) => err.name === "AbortError");
		assert.deepEqual(await leftovers(), []);
	});
});

test("an abort reason that is an Error is passed through", async () =>
{
	await withInput(compressibleData(), async (srcPath, leftovers) =>
	{
		const reason = new Error("shutting down");
		const controller = new AbortController();
		const promise = nativeCompressBest(srcPath, fakeOptions("hang", {
			signal: controller.signal,
			onProgress: () => controller.abort(reason),
		}));

		await assert.rejects(promise, (err) => err === reason);
		assert.deepEqual(await leftovers(), []);
	});
});

test("an already aborted signal rejects before anything is spawned", async () =>
{
	await withInput(compressibleData(), async (srcPath, leftovers) =>
	{
		await assert.rejects(
			nativeCompressBest(srcPath, fakeOptions("ok", { signal: AbortSignal.abort() })),
			(err) => err.name === "AbortError",
		);
		assert.deepEqual(await leftovers(), []);
	});
});

test("onProgress receives the codec as phase and the input size as total", async () =>
{
	const data = compressibleData();

	await withInput(data, async (srcPath) =>
	{
		const seen = [];
		const result = await nativeCompressBest(srcPath, fakeOptions("progress", {
			onProgress: (progress) => seen.push(progress),
		}));

		assert.ok(result);
		assert.deepEqual(seen.map((p) => p.phase), ["zstd", "zstd", "br", "br"]);
		assert.ok(seen.every((p) => p.bytesTotal === data.length));
		assert.equal(seen[1].bytesDone, data.length);
	});
});

test("a throwing onProgress does not fail the run", async () =>
{
	await withInput(compressibleData(), async (srcPath) =>
	{
		const result = await nativeCompressBest(srcPath, fakeOptions("progress", {
			onProgress: () =>
			{
				throw new Error("listener bug");
			},
		}));

		assert.ok(result);
	});
});

test("stderrTail keeps only the last 16 KiB", async () =>
{
	await withInput(compressibleData(), async (srcPath) =>
	{
		const error = await assertRejectsNative(nativeCompressBest(srcPath, fakeOptions("stderr")), /exited with code 5/);

		assert.ok(error.stderrTail.length <= 16 * 1024);
		assert.ok(error.stderrTail.length > 15 * 1024);
		assert.ok(error.stderrTail.endsWith("line 03999 padding\n"));
		assert.ok(!error.stderrTail.includes("line 00000"));
	});
});

test("a binary that cannot be started throws NativeCompressorError", async () =>
{
	await withInput(compressibleData(), async (srcPath, leftovers) =>
	{
		await assertRejectsNative(
			nativeCompressBest(srcPath, { binPath: "/nonexistent/projecto-compress" }),
			/could not start/,
		);
		assert.deepEqual(await leftovers(), []);
	});
});

test("the binary gets exactly the contract argv and an empty environment", async () =>
{
	await withInput(compressibleData(), async (srcPath) =>
	{
		const error = await assertRejectsNative(
			nativeCompressBest(srcPath, fakeOptions("dump", { memoryBudgetMib: 7168 })),
			/exited with code 5/,
		);
		const { argv, env } = JSON.parse(error.stderrTail);
		const dir = path.dirname(srcPath);
		const flag = (name) => argv[argv.indexOf(name) + 1];

		assert.equal(argv[0], "dump");
		assert.equal(argv[1], "compress");
		assert.equal(flag("--codec"), "zstd");
		assert.equal(flag("--root"), await realpath(dir));
		assert.equal(flag("--input"), srcPath);
		assert.equal(path.dirname(flag("--output")), dir);
		assert.ok(flag("--output").endsWith(".zst"));
		assert.equal(flag("--input-size"), String(compressibleData().length));
		assert.equal(flag("--memory-budget-mib"), "7168");
		assert.ok(!argv.includes("--max-window-log"));

		// Bun may add its own variables; nothing from this process may leak in.
		assert.ok(!env.includes("HOME"));
		assert.ok(!env.includes("PATH"));
		assert.ok(!env.includes("TMPDIR"));
	});
});

test("readCompressorConfig validates the budget range and the timeout", () =>
{
	assert.deepEqual(readCompressorConfig({}), { memoryBudgetMib: 6144, timeoutMs: 10_800_000 });
	assert.deepEqual(
		readCompressorConfig({ COMPRESSOR_MEMORY_BUDGET_MIB: "7168", COMPRESSOR_TIMEOUT_MS: "1000" }),
		{ memoryBudgetMib: 7168, timeoutMs: 1000 },
	);
	assert.equal(readCompressorConfig({ COMPRESSOR_MEMORY_BUDGET_MIB: "64" }).memoryBudgetMib, 64);

	for (const bad of ["7169", "abc", "63", "-1", "1.5", "6144 ", "0x10"])
	{
		assert.throws(() => readCompressorConfig({ COMPRESSOR_MEMORY_BUDGET_MIB: bad }), RangeError, bad);
	}

	for (const bad of ["0", "abc", "-5", "2147483648", "10800000000"])
	{
		assert.throws(() => readCompressorConfig({ COMPRESSOR_TIMEOUT_MS: bad }), RangeError, bad);
	}

	assert.equal(readCompressorConfig({ COMPRESSOR_TIMEOUT_MS: "2147483647" }).timeoutMs, 2_147_483_647);
});

test("nativeCompressBest rejects bad arguments before doing any work", async () =>
{
	const absolute = path.join(os.tmpdir(), "projecto-archive-x");

	await assert.rejects(nativeCompressBest("relative/file"), TypeError);
	await assert.rejects(nativeCompressBest(absolute, { binPath: "relative-bin" }), TypeError);
	await assert.rejects(nativeCompressBest(absolute, { binPath: process.execPath, memoryBudgetMib: 7169 }), RangeError);
	await assert.rejects(nativeCompressBest(absolute, { binPath: process.execPath, memoryBudgetMib: 63 }), RangeError);
	await assert.rejects(nativeCompressBest(absolute, { binPath: process.execPath, timeoutMs: 0 }), RangeError);
	await assert.rejects(nativeCompressBest(absolute, { binPath: process.execPath, timeoutMs: 2 ** 31 }), RangeError);
	await assert.rejects(nativeCompressBest(absolute, { binPath: process.execPath, killGraceMs: 2 ** 31 }), RangeError);
	await assert.rejects(nativeCompressBest(absolute, { binPath: process.execPath, killGraceMs: 0 }), RangeError);
	await assert.rejects(nativeCompressBest(absolute, { binPath: process.execPath, minSavingsRatio: 1 }), RangeError);
	await assert.rejects(nativeCompressBest(absolute, { binPath: process.execPath, signal: {} }), TypeError);
});

test("a bad COMPRESSOR_MEMORY_BUDGET_MIB fails the call when no option overrides it", async () =>
{
	const previous = process.env.COMPRESSOR_MEMORY_BUDGET_MIB;

	process.env.COMPRESSOR_MEMORY_BUDGET_MIB = "abc";

	try
	{
		await assert.rejects(
			nativeCompressBest(path.join(os.tmpdir(), "projecto-archive-x"), { binPath: process.execPath }),
			RangeError,
		);
	}
	finally
	{
		if (previous === undefined)
		{
			delete process.env.COMPRESSOR_MEMORY_BUDGET_MIB;
		}
		else
		{
			process.env.COMPRESSOR_MEMORY_BUDGET_MIB = previous;
		}
	}
});

test("an env value that an option overrides is not parsed", async () =>
{
	const saved = { budget: process.env.COMPRESSOR_MEMORY_BUDGET_MIB, timeout: process.env.COMPRESSOR_TIMEOUT_MS };

	process.env.COMPRESSOR_MEMORY_BUDGET_MIB = "abc";
	process.env.COMPRESSOR_TIMEOUT_MS = "abc";

	try
	{
		await withInput(Buffer.alloc(0), async (srcPath) =>
		{
			// Empty file: returns null right after validation.
			assert.equal(await nativeCompressBest(srcPath, { binPath: process.execPath, memoryBudgetMib: 64, timeoutMs: 1000 }), null);
			await assert.rejects(nativeCompressBest(srcPath, { binPath: process.execPath, memoryBudgetMib: 64 }), RangeError);
			await assert.rejects(nativeCompressBest(srcPath, { binPath: process.execPath, timeoutMs: 1000 }), RangeError);
		});
	}
	finally
	{
		for (const [name, value] of [["COMPRESSOR_MEMORY_BUDGET_MIB", saved.budget], ["COMPRESSOR_TIMEOUT_MS", saved.timeout]])
		{
			if (value === undefined)
			{
				delete process.env[name];
			}
			else
			{
				process.env[name] = value;
			}
		}
	}
});

test("a source outside the temp directory is refused", async () =>
{
	const other = await mkdtemp(path.join(os.tmpdir(), "native-compressor-other-"));

	try
	{
		const srcPath = path.join(other, "input");

		await writeFile(srcPath, compressibleData());
		await assert.rejects(nativeCompressBest(srcPath, fakeOptions("ok")), TypeError);
	}
	finally
	{
		await rm(other, { recursive: true, force: true });
	}
});

// Real binary (W17/W18): the former in-process compressBest tests,
// with the output decoded by the download path's createDecompressStream.
const realTest = REAL_BIN ? test : test.skip;

if (!REAL_BIN)
{
	console.log("native-compressor: PROJECTO_COMPRESSOR_BIN is not set, skipping the real-binary tests");
}

const realOptions = () => ({ binPath: REAL_BIN });

realTest("real binary: picks the smallest candidate and it round-trips", async () =>
{
	const data = compressibleData();

	await withInput(data, async (srcPath, leftovers) =>
	{
		const result = await nativeCompressBest(srcPath, realOptions());

		assert.ok(result);
		assert.ok(["zstd", "br"].includes(result.method));
		assert.match(result.encoder ?? "", /projecto-compress/);

		const compressed = await readFile(result.path);

		assert.equal(compressed.length, result.size);
		assert.ok(result.size < data.length / 5);

		// Never worse than the in-process encoder's settings (within framing noise).
		const zstdSize = zlib.zstdCompressSync(data, {
			params: {
				[zlib.constants.ZSTD_c_compressionLevel]: 22,
				[zlib.constants.ZSTD_c_windowLog]: 27,
				[zlib.constants.ZSTD_c_enableLongDistanceMatching]: 1,
				[zlib.constants.ZSTD_c_checksumFlag]: 1,
			},
		}).length;
		const brotliSize = zlib.brotliCompressSync(data, {
			params: {
				[zlib.constants.BROTLI_PARAM_QUALITY]: 11,
				[zlib.constants.BROTLI_PARAM_LGWIN]: 24,
				[zlib.constants.BROTLI_PARAM_SIZE_HINT]: data.length,
			},
		}).length;

		assert.ok(result.size <= Math.min(zstdSize, brotliSize) * 1.02 + 32);
		assert.equal(sha(await decompress(result.method, compressed)), sha(data));
		assert.deepEqual(await leftovers(), [path.basename(result.path)]);
	});
});

realTest("real binary: returns null for random bytes and leaves no temp file", async () =>
{
	await withInput(randomBytes(64 * 1024), async (srcPath, leftovers) =>
	{
		assert.equal(await nativeCompressBest(srcPath, realOptions()), null);
		assert.deepEqual(await leftovers(), []);
	});
});

realTest("real binary: honours minSavingsRatio", async () =>
{
	await withInput(compressibleData(), async (srcPath) =>
	{
		assert.equal(await nativeCompressBest(srcPath, { ...realOptions(), minSavingsRatio: 0.9999 }), null);

		const result = await nativeCompressBest(srcPath, { ...realOptions(), minSavingsRatio: 0 });

		assert.ok(result);
		assert.ok(existsSync(result.path));
	});
});

realTest("real binary: still compresses small files and they round-trip", async () =>
{
	for (const data of [
		Buffer.from("solid scan\n".repeat(40)),
		compressibleData().subarray(0, 5000),
	])
	{
		await withInput(data, async (srcPath) =>
		{
			const result = await nativeCompressBest(srcPath, realOptions());

			assert.ok(result);
			assert.ok(result.size < data.length);
			assert.ok((await decompress(result.method, await readFile(result.path))).equals(data));
		});
	}
});

realTest("real binary: an empty file gives null", async () =>
{
	await withInput(Buffer.alloc(0), async (srcPath) =>
	{
		assert.equal(await nativeCompressBest(srcPath, realOptions()), null);
	});
});

realTest("real binary: a 64 MiB budget refuses zstd for an input of about 8 MB with exit 4 and leaves nothing", async () =>
{
	// 24 copies are 8,269,152 bytes (window 23). zstd level 22 then needs about
	// 141.5 MiB (A6 estimate for 8 MiB), so a 64 MiB budget is over.
	const data = Buffer.from(compressibleData().toString().repeat(24));

	await withInput(data, async (srcPath, leftovers) =>
	{
		const error = await assertRejectsNative(
			nativeCompressBest(srcPath, { ...realOptions(), memoryBudgetMib: 64 }),
			/exited with code 4/,
		);

		assert.equal(error.exitCode, 4);
		assert.deepEqual(await leftovers(), []);
	});
});
