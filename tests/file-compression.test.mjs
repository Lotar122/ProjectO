import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { buffer } from "node:stream/consumers";
import zlib from "node:zlib";
import {
	ARCHIVE_META,
	compressBest,
	createDecompressStream,
	isCompressed,
	windowLogFor,
} from "../src/app/server-functions/orders/fileCompression.js";
import {
	ChecksumMismatchError,
	assertChecksum,
	createChecksumVerifyStream,
} from "../src/app/server-functions/MinIO/checksum.js";

const sha = (data) => createHash("sha256").update(data).digest("hex");

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

async function withTempFile(data, fn)
{
	const filePath = path.join(os.tmpdir(), `projecto-test-${randomUUID()}`);

	await writeFile(filePath, data);

	try
	{
		await fn(filePath);
	}
	finally
	{
		await rm(filePath, { force: true });
	}
}

const decompress = (method, data) => buffer(Readable.from([data]).pipe(createDecompressStream(method)));

test("isCompressed is true only for zstd and br", () =>
{
	assert.equal(ARCHIVE_META.method, "compression");
	assert.equal(ARCHIVE_META.sha256, "sha256");
	assert.equal(isCompressed({ compression: "zstd" }), true);
	assert.equal(isCompressed({ compression: "br" }), true);
	assert.equal(isCompressed({ compression: "identity" }), false);
	assert.equal(isCompressed({}), false);
	assert.equal(isCompressed(undefined), false);
});

test("decompress streams round-trip both codecs", async () =>
{
	const data = compressibleData();

	assert.ok((await decompress("zstd", zlib.zstdCompressSync(data))).equals(data));
	assert.ok((await decompress("br", zlib.brotliCompressSync(data))).equals(data));
	assert.throws(() => createDecompressStream("gzip"));
});

test("compressBest picks the smallest candidate and it round-trips", async () =>
{
	const data = compressibleData();

	await withTempFile(data, async (filePath) =>
	{
		const result = await compressBest(filePath);

		try
		{
			assert.ok(result);
			assert.ok(["zstd", "br"].includes(result.method));

			const compressed = await readFile(result.path);

			assert.equal(compressed.length, result.size);
			assert.ok(result.size < data.length / 5);

			// The winner is (within streaming framing noise) the smaller codec.
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
		}
		finally
		{
			await rm(result?.path ?? "", { force: true });
		}
	});
});

test("compressBest returns null for random bytes and leaves no temp file", async () =>
{
	await withTempFile(randomBytes(64 * 1024), async (filePath) =>
	{
		assert.equal(await compressBest(filePath), null);
	});
});

test("compressBest honours minSavingsRatio", async () =>
{
	await withTempFile(compressibleData(), async (filePath) =>
	{
		assert.equal(await compressBest(filePath, { minSavingsRatio: 0.9999 }), null);

		const result = await compressBest(filePath, { minSavingsRatio: 0 });

		assert.ok(result);
		assert.ok(existsSync(result.path));
		await rm(result.path, { force: true });
	});
});

test("windowLogFor sizes the window to the file within the codec limits", () =>
{
	assert.equal(windowLogFor(1, 27), 10);
	assert.equal(windowLogFor(1000, 27), 10);
	assert.equal(windowLogFor(1024, 27), 10);
	assert.equal(windowLogFor(1025, 27), 11);
	assert.equal(windowLogFor(300 * 1024, 27), 19);
	assert.equal(windowLogFor(64 * 1024 * 1024, 27), 26);
	assert.equal(windowLogFor(250 * 1024 * 1024, 27), 27);
	assert.equal(windowLogFor(250 * 1024 * 1024, 24), 24);
});

test("compressBest still compresses small files and they round-trip", async () =>
{
	for (const data of [
		Buffer.from("solid scan\n".repeat(40)),
		compressibleData().subarray(0, 5000),
	])
	{
		await withTempFile(data, async (filePath) =>
		{
			const result = await compressBest(filePath);

			try
			{
				assert.ok(result);
				assert.ok(result.size < data.length);
				assert.ok((await decompress(result.method, await readFile(result.path))).equals(data));
			}
			finally
			{
				await rm(result?.path ?? "", { force: true });
			}
		});
	}
});

test("compressBest returns null for an empty file", async () =>
{
	await withTempFile(Buffer.alloc(0), async (filePath) =>
	{
		assert.equal(await compressBest(filePath), null);
	});
});

// ---- Checksum verification of decompressed bytes (download path) ----

// Splits data into chunks of chunkSize so the stream sees several writes.
function chunked(data, chunkSize = 4096)
{
	const chunks = [];

	for (let offset = 0; offset < data.length; offset += chunkSize)
	{
		chunks.push(data.subarray(offset, offset + chunkSize));
	}

	return Readable.from(chunks);
}

// Collects what a consumer receives before the stream ends or fails.
function consume(stream)
{
	return new Promise((resolve) =>
	{
		const received = [];

		stream.on("data", (chunk) => received.push(chunk));
		stream.on("end", () => resolve({ data: Buffer.concat(received), error: null }));
		stream.on("error", (error) => resolve({ data: Buffer.concat(received), error }));
	});
}

function decompressAndVerify(method, compressed, expected)
{
	return chunked(compressed)
		.pipe(createDecompressStream(method))
		.pipe(createChecksumVerifyStream("file-1", expected));
}

test("decompressed bytes that match the stored checksum stream through unchanged", async () =>
{
	const data = compressibleData();

	for (const [method, compressed] of [
		["zstd", zlib.zstdCompressSync(data)],
		["br", zlib.brotliCompressSync(data)],
	])
	{
		const { data: received, error } = await consume(
			decompressAndVerify(method, compressed, { sha256: sha(data), size: data.length }),
		);

		assert.equal(error, null);
		assert.ok(received.equals(data));
	}
});

test("decompressed bytes that do not match fail the stream before the last chunk", async () =>
{
	const data = compressibleData();
	const wrong = Buffer.from(data);

	wrong[wrong.length - 1] ^= 0xff;

	const { data: received, error } = await consume(
		decompressAndVerify("zstd", zlib.zstdCompressSync(wrong), { sha256: sha(data), size: data.length }),
	);

	assert.ok(error instanceof ChecksumMismatchError);
	assert.equal(error.expected, sha(data));
	assert.equal(error.actual, sha(wrong));
	assert.deepEqual(error.files, ["file-1"]);
	assert.match(error.message, /Checksum mismatch for: file-1 \(expected sha256 [0-9a-f]{64}, got [0-9a-f]{64}\)/);
	// The consumer never gets the complete (corrupted) content.
	assert.ok(received.length < wrong.length);
	assert.ok(received.equals(wrong.subarray(0, received.length)));
});

test("a stream longer than the stored size fails as soon as it goes past it", async () =>
{
	const data = compressibleData();
	const { data: received, error } = await consume(
		chunked(data).pipe(createChecksumVerifyStream("file-1", { sha256: sha(data), size: 1000 })),
	);

	assert.ok(error instanceof ChecksumMismatchError);
	assert.equal(error.expectedSize, 1000);
	assert.ok(error.actualSize > 1000);
	assert.ok(received.length <= 1000);
});

test("a stream shorter than the stored size fails", async () =>
{
	const data = compressibleData();
	const { error } = await consume(
		chunked(data).pipe(createChecksumVerifyStream("file-1", { sha256: sha(data), size: data.length + 1 })),
	);

	assert.ok(error instanceof ChecksumMismatchError);
	assert.equal(error.expectedSize, data.length + 1);
	assert.equal(error.actualSize, data.length);
});

test("assertChecksum accepts a match and reports expected and actual on a mismatch", () =>
{
	assertChecksum("f", { sha256: sha("a"), size: 1 }, { sha256: sha("a"), size: 1 });
	// The size is only compared when it is expected.
	assertChecksum("f", { sha256: sha("a") }, { sha256: sha("a"), size: 99 });

	assert.throws(
		() => assertChecksum("f", { sha256: sha("a"), size: 1 }, { sha256: sha("b"), size: 1 }),
		(err) => err instanceof ChecksumMismatchError && err.expected === sha("a") && err.actual === sha("b"),
	);
	assert.throws(
		() => assertChecksum("f", { sha256: sha("a"), size: 1 }, { sha256: sha("a"), size: 2 }),
		(err) => err instanceof ChecksumMismatchError && err.expectedSize === 1 && err.actualSize === 2,
	);
	assert.throws(() => assertChecksum("f", { sha256: "nope" }, { sha256: sha("a"), size: 1 }), TypeError);
	assert.throws(() => createChecksumVerifyStream("f", { sha256: sha("a"), size: -1 }), RangeError);
});

test("the upload's ChecksumMismatchError keeps its message without details", () =>
{
	const err = new ChecksumMismatchError(["a.stl", "b.stl"]);

	assert.equal(err.message, "Checksum mismatch for: a.stl, b.stl");
	assert.equal(err.code, "CHECKSUM_MISMATCH");
	assert.equal(err.expected, null);
});
