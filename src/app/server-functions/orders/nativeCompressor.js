import "server-only";

import { spawn } from "node:child_process";
import { lstat, realpath, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createLogger } from "../../lib/logger.js";
import { COMPRESSION_METHODS, createTempFilePath, removeTempFile } from "./fileCompression.js";

// Adapter for the projecto-compress binary (phases-bugfix/phase4.md 7.4 and the
// amendments A1/A5). It is the archiver worker's compressor:
// zstd, then br, one after the other, smallest output wins.
//
// Lifetime: every compress run gets `--watch-stdin 1` and a stdin pipe this
// process holds open and never writes to or ends while the run should go on.
// With that flag the binary removes its partial output and exits 3 when it
// reads EOF there, so it cannot outlive this process, even after a SIGKILL or
// an OOM kill of the worker. A stop closes the pipe before signalling, and a
// normal process exit SIGKILLs any child still running.

export const MEMORY_BUDGET_MIB_MIN = 64;
export const MEMORY_BUDGET_MIB_MAX = 7168;
export const MEMORY_BUDGET_MIB_DEFAULT = 6144;
// zstd threads (`--threads`, native/compressor/README.md): 0 and 1 compress on
// one thread, 2 or more start that many zstd workers. The binary lowers the
// count when the file is small or the memory budget cannot hold that many
// workers. Brotli is single-threaded, so only the zstd run gets the flag.
export const ZSTD_THREADS_MIN = 0;
export const ZSTD_THREADS_MAX = 64;
export const ZSTD_THREADS_DEFAULT = 4;
export const TIMEOUT_MS_DEFAULT = 3 * 60 * 60 * 1000;
// setTimeout clamps anything above 2^31 - 1 ms (about 24.8 days) to 1 ms, which
// would kill the child at once, so larger timer values are refused.
export const TIMER_MS_MAX = 2 ** 31 - 1;

const KILL_GRACE_MS_DEFAULT = 5000;
const STDOUT_MAX_BYTES = 64 * 1024;
const STDOUT_LINE_MAX_BYTES = 4 * 1024;
const STDERR_TAIL_BYTES = 16 * 1024;
const MESSAGE_MAX_CHARS = 500;

const CANDIDATES = [
	{ codec: COMPRESSION_METHODS.zstd, extension: ".zst" },
	{ codec: COMPRESSION_METHODS.brotli, extension: ".br" },
];

// Exit codes of the binary (7.3, native/compressor/README.md). Only 4 is a
// budget refusal. 3 is I/O (also: stdin reached EOF under --watch-stdin 1) and
// 70 is internal (also: malloc failed within the budget); both are ordinary
// run failures, like every other non-zero code.
const EXIT_OK = 0;
const EXIT_MEMORY_BUDGET = 4;

const log = createLogger("native-compressor");

// Children still running, killed when this process exits (see the top note).
const liveChildren = new Set();
let exitHookInstalled = false;

function trackChild(child)
{
	if (!exitHookInstalled)
	{
		exitHookInstalled = true;
		// "exit" handlers must be synchronous; kill() is.
		process.once("exit", () =>
		{
			for (const running of liveChildren)
			{
				running.kill("SIGKILL");
			}
		});
	}

	liveChildren.add(child);
}

// Ends the stdin pipe, the binary's "stop now" signal. Never throws.
function closeStdin(child)
{
	try
	{
		child.stdin?.end();
	}
	catch
	{
		// Already closed.
	}
}

export class NativeCompressorError extends Error
{
	/**
	 * @param {string} message
	 * @param {{ exitCode?: number | null, signal?: string | null, stderrTail?: string }} [details]
	 */
	constructor(message, { exitCode = null, signal = null, stderrTail = "" } = {})
	{
		super(message);
		this.name = "NativeCompressorError";
		this.exitCode = exitCode;
		this.signal = signal;
		this.stderrTail = stderrTail;
	}
}

function parseIntegerEnv(env, name, fallback, min, max)
{
	const raw = env[name];

	if (raw === undefined || raw === "")
	{
		return fallback;
	}

	const value = /^\d+$/.test(raw) ? Number(raw) : Number.NaN;

	if (!Number.isSafeInteger(value) || value < min || value > max)
	{
		throw new RangeError(`${name} must be an integer from ${min} to ${max}, got ${JSON.stringify(raw)}`);
	}

	return value;
}

/**
 * Reads and validates COMPRESSOR_MEMORY_BUDGET_MIB (64 to 7168, default 6144),
 * COMPRESSOR_TIMEOUT_MS (1 to 2147483647, default 3 h) and PROJECTO_ZSTD_THREADS
 * (0 to 64, default 4). The worker calls this at startup so a bad value stops
 * the process before any job runs.
 * @param {Record<string, string | undefined>} [env]
 * @returns {{ memoryBudgetMib: number, timeoutMs: number, zstdThreads: number }}
 */
export function readCompressorConfig(env = process.env)
{
	return { memoryBudgetMib: readMemoryBudgetMib(env), timeoutMs: readTimeoutMs(env), zstdThreads: readZstdThreads(env) };
}

function readMemoryBudgetMib(env)
{
	return parseIntegerEnv(
		env,
		"COMPRESSOR_MEMORY_BUDGET_MIB",
		MEMORY_BUDGET_MIB_DEFAULT,
		MEMORY_BUDGET_MIB_MIN,
		MEMORY_BUDGET_MIB_MAX,
	);
}

function readTimeoutMs(env)
{
	return parseIntegerEnv(env, "COMPRESSOR_TIMEOUT_MS", TIMEOUT_MS_DEFAULT, 1, TIMER_MS_MAX);
}

function readZstdThreads(env)
{
	return parseIntegerEnv(env, "PROJECTO_ZSTD_THREADS", ZSTD_THREADS_DEFAULT, ZSTD_THREADS_MIN, ZSTD_THREADS_MAX);
}

const isSafeCount = (value) => Number.isSafeInteger(value) && value >= 0;

const clip = (text) => (text.length > MESSAGE_MAX_CHARS ? `${text.slice(0, MESSAGE_MAX_CHARS)}...` : text);

function abortReason(signal)
{
	return signal.reason instanceof Error
		? signal.reason
		: new DOMException("The compressor run was aborted", "AbortError");
}

// Runs the binary once and resolves with what happened. It never throws for a
// failing child: the caller turns the outcome into a result or an error.
function runProcess({ binPath, args, cwd, codec, inputSize, timeoutMs, killGraceMs, signal, onProgress })
{
	return new Promise((resolve) =>
	{
		const outcome = {
			exitCode: null,
			signal: null,
			result: null,
			protocolError: null,
			spawnError: null,
			timedOut: false,
			aborted: false,
			stderrTail: "",
		};
		let child;

		try
		{
			// stdin is a pipe kept open for the whole run (see the top note):
			// with --watch-stdin 1, "ignore" (/dev/null) would end the run at once.
			child = spawn(binPath, args, {
				shell: false,
				stdio: ["pipe", "pipe", "pipe"],
				env: {},
				cwd,
				windowsHide: true,
			});
		}
		catch (err)
		{
			outcome.spawnError = err;
			resolve(outcome);
			return;
		}

		// EPIPE once the child has exited; nothing is ever written.
		child.stdin?.on("error", () => undefined);
		trackChild(child);

		let killTimer = null;
		let stdoutBytes = 0;
		let pending = "";
		const stderrChunks = [];
		let stderrBytes = 0;
		let settled = false;

		// Returns true only when it signalled a child that was still running.
		const terminate = () =>
		{
			if (killTimer || child.exitCode !== null || child.signalCode !== null)
			{
				return false;
			}

			closeStdin(child);
			child.kill("SIGTERM");
			killTimer = setTimeout(() => child.kill("SIGKILL"), killGraceMs);

			return true;
		};

		const protocolFail = (message) =>
		{
			outcome.protocolError ??= message;
			terminate();
		};

		const handleLine = (line) =>
		{
			if (outcome.protocolError)
			{
				return;
			}

			let message;

			try
			{
				message = JSON.parse(line);
			}
			catch
			{
				protocolFail(`stdout line is not JSON: ${clip(line)}`);
				return;
			}

			if (message === null || typeof message !== "object" || Array.isArray(message))
			{
				protocolFail("stdout line is not a JSON object");
				return;
			}

			if (outcome.result)
			{
				protocolFail(`stdout line after the result line: ${clip(line)}`);
				return;
			}

			if (message.type === "start")
			{
				return;
			}

			if (message.type === "progress")
			{
				if (!isSafeCount(message.read) || !isSafeCount(message.written))
				{
					protocolFail("progress line has invalid counters");
					return;
				}

				try
				{
					onProgress?.({ phase: codec, bytesDone: message.read, bytesTotal: inputSize });
				}
				catch
				{
					// Progress is advisory; a failing listener must not kill the run.
				}

				return;
			}

			if (message.type === "result")
			{
				outcome.result = message;
				return;
			}

			protocolFail(`unknown stdout line type: ${clip(String(message.type))}`);
		};

		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk) =>
		{
			stdoutBytes += Buffer.byteLength(chunk);

			if (stdoutBytes > STDOUT_MAX_BYTES)
			{
				protocolFail(`stdout is larger than ${STDOUT_MAX_BYTES} bytes`);
				pending = "";
				return;
			}

			pending += chunk;

			let newline = pending.indexOf("\n");

			while (newline !== -1)
			{
				const line = pending.slice(0, newline);

				pending = pending.slice(newline + 1);

				if (Buffer.byteLength(line) > STDOUT_LINE_MAX_BYTES)
				{
					protocolFail(`stdout line is larger than ${STDOUT_LINE_MAX_BYTES} bytes`);
					return;
				}

				if (line.trim() !== "")
				{
					handleLine(line);
				}

				newline = pending.indexOf("\n");
			}

			if (Buffer.byteLength(pending) > STDOUT_LINE_MAX_BYTES)
			{
				protocolFail(`stdout line is larger than ${STDOUT_LINE_MAX_BYTES} bytes`);
				pending = "";
			}
		});

		// Keeps only the last STDERR_TAIL_BYTES of stderr.
		child.stderr.on("data", (chunk) =>
		{
			stderrChunks.push(chunk);
			stderrBytes += chunk.length;

			while (stderrBytes - stderrChunks[0].length >= STDERR_TAIL_BYTES)
			{
				stderrBytes -= stderrChunks.shift().length;
			}
		});

		const timeoutTimer = setTimeout(() =>
		{
			outcome.timedOut = terminate();
		}, timeoutMs);

		const onAbort = () =>
		{
			outcome.aborted = true;
			terminate();
		};

		signal?.addEventListener("abort", onAbort, { once: true });

		const finish = () =>
		{
			if (settled)
			{
				return;
			}

			settled = true;
			clearTimeout(timeoutTimer);
			clearTimeout(killTimer);
			signal?.removeEventListener("abort", onAbort);
			liveChildren.delete(child);
			closeStdin(child);

			if (pending.trim() !== "" && !outcome.protocolError)
			{
				handleLine(pending);
			}

			outcome.stderrTail = Buffer.concat(stderrChunks).subarray(-STDERR_TAIL_BYTES).toString("utf8");
			resolve(outcome);
		};

		// "error" can fire more than once and without a listener it would throw.
		child.on("error", (err) =>
		{
			// Spawn failures (ENOENT, EACCES) arrive here; so can kill failures,
			// which the close event still reports.
			if (child.pid === undefined)
			{
				outcome.spawnError ??= err;
				finish();
			}
		});

		child.on("close", (exitCode, exitSignal) =>
		{
			// A child that never started has no exit status, whatever the runtime reports.
			if (!outcome.spawnError)
			{
				outcome.exitCode = exitCode;
				outcome.signal = exitSignal;
			}

			finish();
		});

		if (signal?.aborted)
		{
			onAbort();
		}
	});
}

function describeFailure(codec, outcome)
{
	const detail = outcome.result?.ok === false && typeof outcome.result.message === "string"
		? `: ${clip(outcome.result.message)}`
		: "";

	if (outcome.signal)
	{
		const oom = outcome.signal === "SIGKILL" ? " (likely OOM killed)" : "";

		return `projecto-compress ${codec} was terminated by ${outcome.signal}${oom}${detail}`;
	}

	return `projecto-compress ${codec} exited with code ${outcome.exitCode}${detail}`;
}

// The error for a run that did not produce a result, or null when the child
// exited 0. Protocol errors and aborts are handled by the caller first.
function describeRunError(codec, outcome, timeoutMs, failure)
{
	if (outcome.spawnError)
	{
		return new NativeCompressorError(`projecto-compress could not start: ${outcome.spawnError.message}`, failure);
	}

	if (outcome.timedOut)
	{
		return new NativeCompressorError(`projecto-compress ${codec} timed out after ${timeoutMs} ms`, failure);
	}

	if (outcome.exitCode !== EXIT_OK)
	{
		return new NativeCompressorError(describeFailure(codec, outcome), failure);
	}

	return null;
}

async function readValidatedResult(codec, outcome, srcPath, outputPath, inputSize)
{
	const { result } = outcome;
	const fail = (reason) => new NativeCompressorError(
		`projecto-compress ${codec} protocol error: ${reason}`,
		{ exitCode: outcome.exitCode, signal: outcome.signal, stderrTail: outcome.stderrTail },
	);

	if (!result)
	{
		throw fail("no result line");
	}

	if (result.ok !== true)
	{
		throw fail("exit code 0 with a failed result line");
	}

	if (result.codec !== codec)
	{
		throw fail(`result codec ${JSON.stringify(result.codec)} does not match the request`);
	}

	for (const key of ["inputSize", "outputSize", "peakBytes", "workers", "elapsedMs"])
	{
		if (result[key] !== undefined && !isSafeCount(result[key]))
		{
			throw fail(`result ${key} is not a safe integer`);
		}
	}

	if (result.encoder !== undefined && (typeof result.encoder !== "string" || result.encoder.length > 200))
	{
		throw fail("result encoder is not a short string");
	}

	const [srcStat, outputStat] = await Promise.all([stat(srcPath).catch(() => null), stat(outputPath).catch(() => null)]);

	if (!srcStat || result.inputSize !== srcStat.size || srcStat.size !== inputSize)
	{
		throw fail(`result inputSize ${result.inputSize} does not match the input file (${srcStat?.size ?? "missing"})`);
	}

	if (!outputStat || result.outputSize !== outputStat.size || outputStat.size === 0)
	{
		throw fail(`result outputSize ${result.outputSize} does not match the output file (${outputStat?.size ?? "missing"})`);
	}

	return { size: outputStat.size, encoder: result.encoder ?? null };
}

function validateOptions(srcPath, options)
{
	if (typeof srcPath !== "string" || !path.isAbsolute(srcPath))
	{
		throw new TypeError("srcPath must be an absolute path");
	}

	const { minSavingsRatio = 0.02, binPath = process.env.PROJECTO_COMPRESSOR_BIN, binArgs = [], killGraceMs = KILL_GRACE_MS_DEFAULT } = options;

	if (typeof minSavingsRatio !== "number" || !(minSavingsRatio >= 0 && minSavingsRatio < 1))
	{
		throw new RangeError("minSavingsRatio must be a number from 0 up to (not including) 1");
	}

	if (typeof binPath !== "string" || !path.isAbsolute(binPath))
	{
		throw new TypeError("binPath must be an absolute path (set PROJECTO_COMPRESSOR_BIN)");
	}

	if (!Array.isArray(binArgs) || !binArgs.every((arg) => typeof arg === "string"))
	{
		throw new TypeError("binArgs must be an array of strings");
	}

	if (!Number.isSafeInteger(killGraceMs) || killGraceMs < 1 || killGraceMs > TIMER_MS_MAX)
	{
		throw new RangeError(`killGraceMs must be an integer from 1 to ${TIMER_MS_MAX}`);
	}

	if (options.signal !== undefined && !(options.signal instanceof AbortSignal))
	{
		throw new TypeError("signal must be an AbortSignal");
	}

	if (options.onProgress !== undefined && typeof options.onProgress !== "function")
	{
		throw new TypeError("onProgress must be a function");
	}

	// Only the env values the options do not override are read (and validated).
	const memoryBudgetMib = options.memoryBudgetMib ?? readMemoryBudgetMib(process.env);
	const timeoutMs = options.timeoutMs ?? readTimeoutMs(process.env);
	const zstdThreads = options.zstdThreads ?? readZstdThreads(process.env);

	if (!Number.isSafeInteger(memoryBudgetMib) || memoryBudgetMib < MEMORY_BUDGET_MIB_MIN || memoryBudgetMib > MEMORY_BUDGET_MIB_MAX)
	{
		throw new RangeError(`memoryBudgetMib must be an integer from ${MEMORY_BUDGET_MIB_MIN} to ${MEMORY_BUDGET_MIB_MAX}`);
	}

	if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > TIMER_MS_MAX)
	{
		throw new RangeError(`timeoutMs must be an integer from 1 to ${TIMER_MS_MAX}`);
	}

	if (!Number.isSafeInteger(zstdThreads) || zstdThreads < ZSTD_THREADS_MIN || zstdThreads > ZSTD_THREADS_MAX)
	{
		throw new RangeError(`zstdThreads must be an integer from ${ZSTD_THREADS_MIN} to ${ZSTD_THREADS_MAX}`);
	}

	return { minSavingsRatio, binPath, binArgs, killGraceMs, memoryBudgetMib, timeoutMs, zstdThreads };
}

/**
 * Compresses srcPath with the native binary, zstd then br, and keeps the
 * smaller output. Resolves to
 * { method, path, size, encoder } with the result in a temp file the caller
 * must remove, or null for an empty file or when the best result saves less
 * than minSavingsRatio. srcPath must be a direct child of the OS temp
 * directory (the archiver worker downloads there, with TMPDIR=/work/tmp),
 * because the binary only reads and writes inside its --root.
 *
 * Exit 4 (memory budget) skips br and fails zstd. Exit 70 (internal, including
 * a malloc failure within the budget) is not a budget refusal: it is handled
 * like any other failed run. When br fails to run (it
 * cannot start, times out, is killed or exits non-zero) after zstd produced a
 * valid result, the zstd result is kept and a warning is logged. Every other
 * failure throws NativeCompressorError: any zstd failure, and a br protocol
 * error or invalid br result (for example a source that changed size). An
 * abort rejects with signal.reason. Outputs are removed on every path except
 * the one returned.
 *
 * @param {string} srcPath absolute path of the original
 * @param {object} [options]
 * @param {number} [options.minSavingsRatio=0.02] fraction of the original that must be saved
 * @param {string} [options.binPath] absolute path of the binary, default PROJECTO_COMPRESSOR_BIN
 * @param {number} [options.memoryBudgetMib] 64 to 7168, default COMPRESSOR_MEMORY_BUDGET_MIB or 6144
 * @param {number} [options.timeoutMs] per codec run, 1 to 2147483647, default COMPRESSOR_TIMEOUT_MS or 3 h
 * @param {number} [options.zstdThreads] zstd `--threads`, 0 to 64, default PROJECTO_ZSTD_THREADS or 4 (br ignores it)
 * @param {AbortSignal} [options.signal] SIGTERM, then SIGKILL after killGraceMs
 * @param {(progress: { phase: string, bytesDone: number, bytesTotal: number }) => void} [options.onProgress] phase is "zstd" or "br"
 * @param {readonly string[]} [options.binArgs] TEST ONLY: arguments placed before "compress", so tests can run a fake through process.execPath. Never fill it from config, env or user input: whatever it holds is passed to the binary as argv.
 * @param {number} [options.killGraceMs=5000] wait between SIGTERM and SIGKILL, 1 to 2147483647
 * @returns {Promise<{ method: string, path: string, size: number, encoder: string | null } | null>}
 */
export async function nativeCompressBest(srcPath, options = {})
{
	const { minSavingsRatio, binPath, binArgs, killGraceMs, memoryBudgetMib, timeoutMs, zstdThreads } = validateOptions(srcPath, options);
	const { signal, onProgress } = options;

	signal?.throwIfAborted();

	let srcStat;

	try
	{
		srcStat = await lstat(srcPath);
	}
	catch (err)
	{
		throw new NativeCompressorError(`source file is not readable: ${err.message}`);
	}

	if (!srcStat.isFile())
	{
		throw new TypeError("srcPath must be a regular file, not a symlink or directory");
	}

	const originalSize = srcStat.size;

	if (originalSize === 0)
	{
		return null;
	}

	const root = await realpath(os.tmpdir());

	if (path.dirname(await realpath(srcPath)) !== root)
	{
		throw new TypeError(`srcPath must be a direct child of the temp directory ${root}`);
	}

	let best = null;

	try
	{
		for (const { codec, extension } of CANDIDATES)
		{
			signal?.throwIfAborted();

			const outputPath = createTempFilePath(extension);
			let kept = false;

			try
			{
				const args = [
					...binArgs,
					"compress",
					"--codec", codec,
					"--root", root,
					"--input", srcPath,
					"--output", outputPath,
					"--input-size", String(originalSize),
					"--memory-budget-mib", String(memoryBudgetMib),
					// The child gets an empty environment, so the thread count is an argument.
					...(codec === COMPRESSION_METHODS.zstd ? ["--threads", String(zstdThreads)] : []),
					"--watch-stdin", "1",
				];
				const outcome = await runProcess({
					binPath,
					args,
					cwd: root,
					codec,
					inputSize: originalSize,
					timeoutMs,
					killGraceMs,
					signal,
					onProgress,
				});
				const failure = { exitCode: outcome.exitCode, signal: outcome.signal, stderrTail: outcome.stderrTail };

				// Never falls back: a stop must stop, and a binary that broke
				// its protocol is not trusted for this file at all.
				if (outcome.aborted)
				{
					throw abortReason(signal);
				}

				if (outcome.protocolError && !outcome.spawnError && !outcome.timedOut)
				{
					throw new NativeCompressorError(`projecto-compress ${codec} protocol error: ${outcome.protocolError}`, failure);
				}

				if (outcome.exitCode === EXIT_MEMORY_BUDGET && codec === COMPRESSION_METHODS.brotli)
				{
					continue;
				}

				const runError = describeRunError(codec, outcome, timeoutMs, failure);

				if (runError)
				{
					// The run itself failed (no start, timeout, crash, error
					// exit). An earlier codec's result was fully validated on
					// its own and is kept.
					if (!best)
					{
						throw runError;
					}

					log.warn(`${runError.message}; keeping the ${best.method} result`);
					continue;
				}

				// A result that fails validation (including a source whose size
				// changed) throws, and drops the earlier result too.
				const { size, encoder } = await readValidatedResult(codec, outcome, srcPath, outputPath, originalSize);

				if (!best || size < best.size)
				{
					await removeTempFile(best?.path);
					best = { method: codec, path: outputPath, size, encoder };
					kept = true;
				}
			}
			finally
			{
				if (!kept)
				{
					await removeTempFile(outputPath);
				}
			}
		}
	}
	catch (err)
	{
		await removeTempFile(best?.path);
		throw err;
	}

	if (!best || (originalSize - best.size) / originalSize < minSavingsRatio)
	{
		await removeTempFile(best?.path);
		return null;
	}

	return best;
}
