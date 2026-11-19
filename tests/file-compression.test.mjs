import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { buffer } from "node:stream/consumers";
import zlib from "node:zlib";
import {
	ARCHIVE_META,
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

// Frames the archiver worker writes: zstd with a 2^28 window and brotli in
// large-window mode. Both decode to "solid fixture\n" x 64 (896 bytes).
// zstd: `zstd --ultra -22 --long=28` reading stdin, so the content size is
// unknown and the frame declares a 256 MiB window.
// brotli: `brotli -q 11 --large_window=25`.
const FIXTURE_PLAIN_SHA256 = "0b8dacae3ed6914ed65218cec368a3b47bf587a97b8b8eed834a8b11fb7ccb85";
const FIXTURE_ZSTD_WINDOW_28 = Buffer.from("KLUv/QSQtQAAeHNvbGlkIGZpeHR1cmUKcwEAbqOadf//BmQ=", "base64");
const FIXTURE_BROTLI_LARGE_WINDOW = Buffer.from("EVn8DeB3pE597sKVWVoqyOFlGV1dDdJbPeAbdrH0Dg==", "base64");

const decodeWith = (decoder, data) => buffer(Readable.from([data]).pipe(decoder));

test("createDecompressStream decodes a zstd frame with a 2^28 window that a plain decoder rejects", async () =>
{
	const decoded = await decompress("zstd", FIXTURE_ZSTD_WINDOW_28);

	assert.equal(decoded.length, 896);
	assert.equal(sha(decoded), FIXTURE_PLAIN_SHA256);
	assert.ok(decoded.equals(Buffer.from("solid fixture\n".repeat(64))));

	await assert.rejects(decodeWith(zlib.createZstdDecompress(), FIXTURE_ZSTD_WINDOW_28));
});

test("createDecompressStream decodes a large-window brotli stream that a plain decoder rejects", async () =>
{
	const decoded = await decompress("br", FIXTURE_BROTLI_LARGE_WINDOW);

	assert.equal(decoded.length, 896);
	assert.equal(sha(decoded), FIXTURE_PLAIN_SHA256);

	await assert.rejects(decodeWith(zlib.createBrotliDecompress(), FIXTURE_BROTLI_LARGE_WINDOW));
});

// Same input, larger windows (`brotli -q 11 --large_window=N` and
// `zstd --ultra -22 --long=29`, both reading stdin). The decoder must accept
// brotli up to 2^28 and refuse the rest: the download budget assumes 2^28.
const FIXTURE_BROTLI_WINDOW_28 = Buffer.from("EVz8DeB3pE597sKVWVoqyOFlGV1dDdJbPeAbdrH0Dg==", "base64");
const FIXTURE_BROTLI_WINDOW_29 = Buffer.from("EV38DeB3pE597sKVWVoqyOFlGV1dDdJbPeAbdrH0Dg==", "base64");
const FIXTURE_BROTLI_WINDOW_30 = Buffer.from("EV78DeB3pE597sKVWVoqyOFlGV1dDdJbPeAbdrH0Dg==", "base64");
const FIXTURE_ZSTD_WINDOW_29 = Buffer.from("KLUv/QSYtQAAeHNvbGlkIGZpeHR1cmUKcwEAbqOadf//BmQ=", "base64");

test("createDecompressStream accepts a brotli window of 28 bits and rejects 29 and 30", async () =>
{
	assert.equal(sha(await decompress("br", FIXTURE_BROTLI_WINDOW_28)), FIXTURE_PLAIN_SHA256);

	for (const fixture of [FIXTURE_BROTLI_WINDOW_29, FIXTURE_BROTLI_WINDOW_30])
	{
		await assert.rejects(decompress("br", fixture), RangeError);
	}
});

test("the brotli window check also works when the header arrives one byte at a time", async () =>
{
	const oneByteAtATime = (data) => Readable.from(Array.from(data, (byte) => Buffer.from([byte])));

	assert.equal(
		sha(await buffer(oneByteAtATime(FIXTURE_BROTLI_WINDOW_28).pipe(createDecompressStream("br")))),
		FIXTURE_PLAIN_SHA256,
	);
	await assert.rejects(
		buffer(oneByteAtATime(FIXTURE_BROTLI_WINDOW_29).pipe(createDecompressStream("br"))),
		RangeError,
	);
});

test("the brotli window check leaves standard windows alone and lets the decoder report a cut-off header", async () =>
{
	const data = compressibleData();

	for (const lgwin of [10, 16, 18, 22, 24])
	{
		const compressed = zlib.brotliCompressSync(data, {
			params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 5, [zlib.constants.BROTLI_PARAM_LGWIN]: lgwin },
		});

		assert.ok((await decompress("br", compressed)).equals(data), `lgwin ${lgwin}`);
	}

	// One byte of a large-window header, then the end of the stream.
	await assert.rejects(decompress("br", FIXTURE_BROTLI_WINDOW_28.subarray(0, 1)));
});

test("an empty brotli body fails like a stock decoder instead of decoding to nothing", async () =>
{
	await assert.rejects(decompress("br", Buffer.alloc(0)), /unexpected end of file/);
	await assert.rejects(buffer(Readable.from([]).pipe(createDecompressStream("br"))), /unexpected end of file/);
});

test("createDecompressStream rejects a zstd frame with a 2^29 window", async () =>
{
	await assert.rejects(decompress("zstd", FIXTURE_ZSTD_WINDOW_29));
});

test("the decoder flags keep decoding old frames: zstd window <= 27 and standard brotli", async () =>
{
	const data = compressibleData();
	const zstd27 = zlib.zstdCompressSync(data, {
		params: {
			[zlib.constants.ZSTD_c_compressionLevel]: 22,
			[zlib.constants.ZSTD_c_windowLog]: 27,
			[zlib.constants.ZSTD_c_enableLongDistanceMatching]: 1,
		},
	});
	const brotli24 = zlib.brotliCompressSync(data, {
		params: {
			[zlib.constants.BROTLI_PARAM_QUALITY]: 11,
			[zlib.constants.BROTLI_PARAM_LGWIN]: 24,
		},
	});

	assert.ok((await decompress("zstd", zstd27)).equals(data));
	assert.ok((await decompress("br", brotli24)).equals(data));
});

// A zstd frame written by the in-process encoder that W25(b) removed
// (zlib.createZstdCompress: level 22, windowLog = windowLogFor(size, 27) = 10,
// long-distance matching, checksum on, pledgedSrcSize = 960, so the frame
// header carries the content size). Objects archived before the native
// compressor look like this, so they must keep decoding.
const FIXTURE_OLD_ENCODER_PLAIN = Buffer.from("old encoder fixture\n".repeat(48));
const FIXTURE_OLD_ENCODER_ZSTD = Buffer.from("KLUv/WTAAuUAAKhvbGQgZW5jb2RlciBmaXh0dXJlCm8BAFFfNZnQ5SZJ", "base64");

test("createDecompressStream still decodes a zstd frame from the old in-process encoder", async () =>
{
	const decoded = await decompress("zstd", FIXTURE_OLD_ENCODER_ZSTD);

	assert.equal(decoded.length, 960);
	assert.ok(decoded.equals(FIXTURE_OLD_ENCODER_PLAIN));
	assert.equal(sha(decoded), "c465a02ff3bdea1800378a4d5cfa4495e3d568a47541e70176db0dc4fd60c457");
});

test("windowLogFor sizes the window to the file within the codec limits", () =>
{
	const MiB = 1024 * 1024;

	assert.equal(windowLogFor(1, 28), 10);
	assert.equal(windowLogFor(1000, 28), 10);
	assert.equal(windowLogFor(1024, 28), 10);
	assert.equal(windowLogFor(1025, 28), 11);
	assert.equal(windowLogFor(300 * 1024, 28), 19);
	assert.equal(windowLogFor(64 * MiB, 28), 26);
	assert.equal(windowLogFor(64 * MiB + 1, 28), 27);
	assert.equal(windowLogFor(128 * MiB, 28), 27);
	assert.equal(windowLogFor(128 * MiB + 1, 28), 28);
	assert.equal(windowLogFor(250 * MiB, 28), 28);
	assert.equal(windowLogFor(1024 * MiB, 28), 28);
	assert.equal(windowLogFor(250 * MiB, 27), 27);
	assert.equal(windowLogFor(250 * MiB, 24), 24);
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
