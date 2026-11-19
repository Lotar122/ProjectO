import "server-only";

import { spawn } from "node:child_process";
import { lstat, realpath, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { COMPRESSION_METHODS, createTempFilePath, removeTempFile } from "./fileCompression.js";

// Adapter for the projecto-compress binary (phases-bugfix/phase4.md 7.4 and the
// amendments A1/A5). It is the archiver worker's compressor:
// zstd, then br, one after the other, smallest output wins.

export const MEMORY_BUDGET_MIB_MIN = 64;
export const MEMORY_BUDGET_MIB_MAX = 7168;
export const MEMORY_BUDGET_MIB_DEFAULT = 6144;
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

// Exit codes of the binary (7.3).
const EXIT_OK = 0;
const EXIT_MEMORY_BUDGET = 4;

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
 * Reads and validates COMPRESSOR_MEMORY_BUDGET_MIB (64 to 7168, default 6144)
 * and COMPRESSOR_TIMEOUT_MS (1 to 2147483647, default 3 h). The worker calls this at startup so
 * a bad value stops the process before any job runs.
 * @param {Record<string, string | undefined>} [env]
 * @returns {{ memoryBudgetMib: number, timeoutMs: number }}
 */
export function readCompressorConfig(env = process.env)
{
	return { memoryBudgetMib: readMemoryBudgetMib(env), timeoutMs: readTimeoutMs(env) };
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
			child = spawn(binPath, args, {
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
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

	for (const key of ["inputSize", "outputSize", "peakBytes", "elapsedMs"])
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

	if (!Number.isSafeInteger(memoryBudgetMib) || memoryBudgetMib < MEMORY_BUDGET_MIB_MIN || memoryBudgetMib > MEMORY_BUDGET_MIB_MAX)
	{
		throw new RangeError(`memoryBudgetMib must be an integer from ${MEMORY_BUDGET_MIB_MIN} to ${MEMORY_BUDGET_MIB_MAX}`);
	}

	if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > TIMER_MS_MAX)
	{
		throw new RangeError(`timeoutMs must be an integer from 1 to ${TIMER_MS_MAX}`);
	}

	return { minSavingsRatio, binPath, binArgs, killGraceMs, memoryBudgetMib, timeoutMs };
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
 * Exit 4 (memory budget) skips br and fails zstd. Every other failure throws
 * NativeCompressorError. An abort rejects with signal.reason. Outputs are
 * removed on every path except the one returned.
 *
 * @param {string} srcPath absolute path of the original
 * @param {object} [options]
 * @param {number} [options.minSavingsRatio=0.02] fraction of the original that must be saved
 * @param {string} [options.binPath] absolute path of the binary, default PROJECTO_COMPRESSOR_BIN
 * @param {number} [options.memoryBudgetMib] 64 to 7168, default COMPRESSOR_MEMORY_BUDGET_MIB or 6144
 * @param {number} [options.timeoutMs] per codec run, 1 to 2147483647, default COMPRESSOR_TIMEOUT_MS or 3 h
 * @param {AbortSignal} [options.signal] SIGTERM, then SIGKILL after killGraceMs
 * @param {(progress: { phase: string, bytesDone: number, bytesTotal: number }) => void} [options.onProgress] phase is "zstd" or "br"
 * @param {readonly string[]} [options.binArgs] TEST ONLY: arguments placed before "compress", so tests can run a fake through process.execPath. Never fill it from config, env or user input: whatever it holds is passed to the binary as argv.
 * @param {number} [options.killGraceMs=5000] wait between SIGTERM and SIGKILL, 1 to 2147483647
 * @returns {Promise<{ method: string, path: string, size: number, encoder: string | null } | null>}
 */
export async function nativeCompressBest(srcPath, options = {})
{
	const { minSavingsRatio, binPath, binArgs, killGraceMs, memoryBudgetMib, timeoutMs } = validateOptions(srcPath, options);
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

				if (outcome.aborted)
				{
					throw abortReason(signal);
				}

				if (outcome.spawnError)
				{
					throw new NativeCompressorError(
						`projecto-compress could not start: ${outcome.spawnError.message}`,
						failure,
					);
				}

				if (outcome.timedOut)
				{
					throw new NativeCompressorError(`projecto-compress ${codec} timed out after ${timeoutMs} ms`, failure);
				}

				if (outcome.protocolError)
				{
					throw new NativeCompressorError(`projecto-compress ${codec} protocol error: ${outcome.protocolError}`, failure);
				}

				if (outcome.exitCode === EXIT_MEMORY_BUDGET && codec === COMPRESSION_METHODS.brotli)
				{
					continue;
				}

				if (outcome.exitCode !== EXIT_OK)
				{
					throw new NativeCompressorError(describeFailure(codec, outcome), failure);
				}

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
