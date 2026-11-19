import path from "node:path";

// Reads `projecto-compress --version` (one JSON line, phase4.md 7.2), so the
// worker registry shows which encoder build is deployed. Bun-only (Bun.spawn):
// the worker always runs on Bun.

const VERSION_TIMEOUT_MS = 10_000;
const STDOUT_MAX_BYTES = 4 * 1024;
const VERSION_FIELD = /^[0-9A-Za-z.+_-]{1,40}$/;

// Reads the stream as UTF-8, or resolves to null (and stops reading) once it
// is larger than STDOUT_MAX_BYTES.
async function readBounded(stream)
{
	const reader = stream.getReader();
	const chunks = [];
	let size = 0;

	for (;;)
	{
		const { done, value } = await reader.read();

		if (done)
		{
			return Buffer.concat(chunks).toString("utf8");
		}

		size += value.byteLength;

		if (size > STDOUT_MAX_BYTES)
		{
			await reader.cancel();
			return null;
		}

		chunks.push(value);
	}
}

/**
 * @param {object} options
 * @param {string} options.binPath Absolute path of projecto-compress.
 * @param {readonly string[]} [options.binArgs] TEST ONLY: arguments placed before
 *   "--version", so tests can run a script through process.execPath.
 * @param {number} [options.timeoutMs]
 * @returns {Promise<string>} For example "projecto-compress 1.0.0 zstd 1.5.7 brotli 1.1.0".
 */
export async function readCompressorVersion({ binPath, binArgs = [], timeoutMs = VERSION_TIMEOUT_MS })
{
	if (typeof binPath !== "string" || !path.isAbsolute(binPath))
	{
		throw new TypeError("binPath must be an absolute path (set PROJECTO_COMPRESSOR_BIN)");
	}

	if (!Array.isArray(binArgs) || !binArgs.every((arg) => typeof arg === "string"))
	{
		throw new TypeError("binArgs must be an array of strings");
	}

	const child = Bun.spawn([binPath, ...binArgs, "--version"], {
		stdin: "ignore",
		stdout: "pipe",
		stderr: "ignore",
		env: {},
		timeout: timeoutMs,
	});
	const stdout = await readBounded(child.stdout);

	if (stdout === null)
	{
		child.kill("SIGKILL");
		await child.exited;
		throw new Error("projecto-compress --version printed too much");
	}

	const exitCode = await child.exited;

	if (exitCode !== 0)
	{
		throw new Error(`projecto-compress --version exited with code ${exitCode}`);
	}

	let info;

	try
	{
		info = JSON.parse(stdout.trim());
	}
	catch
	{
		throw new Error("projecto-compress --version did not print JSON");
	}

	const fields = ["version", "zstd", "brotli"].map((name) => [name, info?.[name]]);

	if (info?.type !== "version" || !fields.every(([, value]) => typeof value === "string" && VERSION_FIELD.test(value)))
	{
		throw new Error("projecto-compress --version printed an unexpected line");
	}

	const [[, version], [, zstd], [, brotli]] = fields;

	return `projecto-compress ${version} zstd ${zstd} brotli ${brotli}`;
}
