import "server-only";

import { randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import zlib from "node:zlib";

// Keys of the S3 user metadata that describe how an order file is stored.
// `compression` is "zstd" or "br" for compressed bytes, "identity" for files
// that were checked but left as they were (compression would not pay off).
// `original_size` is the size of the original bytes, `archived_at` an ISO date.
export const ARCHIVE_META = {
	method: "compression",
	originalSize: "original_size",
	archivedAt: "archived_at",
};

export const COMPRESSION_METHODS = {
	zstd: "zstd",
	brotli: "br",
	identity: "identity",
};

const MAX_BROTLI_SIZE_HINT = 0xffffffff;

// Smallest window both codecs accept.
const MIN_WINDOW_LOG = 10;
// A 27-bit window is zstd's default decoder limit, so the download path needs
// no special decoder parameter.
const MAX_ZSTD_WINDOW_LOG = 27;
const MAX_BROTLI_WINDOW_LOG = 24;

// A window larger than the file gains nothing and only costs memory, so it is
// sized to the file (log2 of the size, rounded up, within the codec's limits).
export function windowLogFor(size, maxWindowLog)
{
	const needed = size > 1 ? Math.ceil(Math.log2(size)) : MIN_WINDOW_LOG;

	return Math.min(Math.max(needed, MIN_WINDOW_LOG), maxWindowLog);
}

// Strongest settings of both built-in codecs. CPU time does not matter for the
// archiver, so each file gets both and the smaller result wins.
const CANDIDATES = [
	{
		method: COMPRESSION_METHODS.zstd,
		extension: ".zst",
		// pledgedSrcSize matters most for memory: without a known source size,
		// level 22 allocates its full hash/chain tables (~0.7 GB) even for a
		// small file; with it zstd shrinks them to the input. It also records
		// the content size in the frame header. Bun 1.3's node:zlib supports it
		// (ZSTD_c_srcSizeHint is not exposed there).
		create: (size) => zlib.createZstdCompress({
			pledgedSrcSize: size,
			params: {
				[zlib.constants.ZSTD_c_compressionLevel]: 22,
				[zlib.constants.ZSTD_c_windowLog]: windowLogFor(size, MAX_ZSTD_WINDOW_LOG),
				[zlib.constants.ZSTD_c_enableLongDistanceMatching]: 1,
				[zlib.constants.ZSTD_c_checksumFlag]: 1,
			},
		}),
	},
	{
		method: COMPRESSION_METHODS.brotli,
		extension: ".br",
		create: (size) => zlib.createBrotliCompress({
			params: {
				[zlib.constants.BROTLI_PARAM_QUALITY]: 11,
				[zlib.constants.BROTLI_PARAM_LGWIN]: windowLogFor(size, MAX_BROTLI_WINDOW_LOG),
				[zlib.constants.BROTLI_PARAM_SIZE_HINT]: Math.min(size, MAX_BROTLI_SIZE_HINT),
			},
		}),
	},
];

// True only for metadata of bytes that must be decompressed before use.
export function isCompressed(metadata)
{
	const method = metadata?.[ARCHIVE_META.method];

	return method === COMPRESSION_METHODS.zstd || method === COMPRESSION_METHODS.brotli;
}

export function createDecompressStream(method)
{
	if (method === COMPRESSION_METHODS.zstd)
	{
		return zlib.createZstdDecompress();
	}

	if (method === COMPRESSION_METHODS.brotli)
	{
		return zlib.createBrotliDecompress();
	}

	throw new Error(`Unsupported compression method: ${method}`);
}

// A fresh path in the OS temp directory; the caller removes the file.
export function createTempFilePath(extension = "")
{
	return path.join(os.tmpdir(), `projecto-archive-${randomUUID()}${extension}`);
}

export async function removeTempFile(filePath)
{
	if (filePath)
	{
		await rm(filePath, { force: true });
	}
}

// Compresses srcPath with every candidate codec (one after another, since
// zstd at level 22 on a large file needs a lot of memory) and keeps the
// smallest result. Resolves to { method, path, size } with the result in a
// temp file the caller must remove, or null when the best result saves less
// than minSavingsRatio of the original size (already compressed formats).
export async function compressBest(srcPath, { minSavingsRatio = 0.02 } = {})
{
	const { size: originalSize } = await stat(srcPath);

	if (originalSize === 0)
	{
		return null;
	}

	let best = null;

	try
	{
		for (const candidate of CANDIDATES)
		{
			const candidatePath = createTempFilePath(candidate.extension);

			try
			{
				await pipeline(
					createReadStream(srcPath),
					candidate.create(originalSize),
					createWriteStream(candidatePath),
				);
			}
			catch (err)
			{
				await removeTempFile(candidatePath);
				throw err;
			}

			const { size } = await stat(candidatePath);

			if (!best || size < best.size)
			{
				await removeTempFile(best?.path);
				best = { method: candidate.method, path: candidatePath, size };
			}
			else
			{
				await removeTempFile(candidatePath);
			}
		}
	}
	catch (err)
	{
		await removeTempFile(best?.path);
		throw err;
	}

	if ((originalSize - best.size) / originalSize < minSavingsRatio)
	{
		await removeTempFile(best.path);
		return null;
	}

	return best;
}
