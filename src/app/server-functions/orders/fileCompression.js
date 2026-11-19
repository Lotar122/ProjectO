import "server-only";

import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";

// Keys of the S3 user metadata that describe how an order file is stored.
// `compression` is "zstd" or "br" for compressed bytes, "identity" for files
// that were checked but left as they were (compression would not pay off).
// `original_size` is the size of the original bytes, `archived_at` an ISO date.
// `sha256` is the hex sha256 of the original (uncompressed) bytes. It is the
// same key the upload stores, so the archiver checks against it before
// compressing and the download checks the decompressed bytes against it.
export const ARCHIVE_META = {
	method: "compression",
	originalSize: "original_size",
	archivedAt: "archived_at",
	sha256: "sha256",
};

export const COMPRESSION_METHODS = {
	zstd: "zstd",
	brotli: "br",
	identity: "identity",
};

// Smallest window both codecs accept.
const MIN_WINDOW_LOG = 10;
// Largest window the decoders accept (and the archiver worker may write). Uploads
// are capped at 250 MiB, below 2^28, so nothing larger is ever needed. If the
// upload cap goes above 256 MiB, raise these together with the decode-budget
// weights in downloadDecodeBudget.js. Brotli above 24 uses the large-window format.
export const ZSTD_MAX_WINDOW_LOG = 28;
export const BROTLI_MAX_WINDOW_LOG = 28;

// A window larger than the file gains nothing and only costs memory, so it is
// sized to the file (log2 of the size, rounded up, within the codec's limits).
export function windowLogFor(size, maxWindowLog)
{
	const needed = size > 1 ? Math.ceil(Math.log2(size)) : MIN_WINDOW_LOG;

	return Math.min(Math.max(needed, MIN_WINDOW_LOG), maxWindowLog);
}

// True only for metadata of bytes that must be decompressed before use.
export function isCompressed(metadata)
{
	const method = metadata?.[ARCHIVE_META.method];

	return method === COMPRESSION_METHODS.zstd || method === COMPRESSION_METHODS.brotli;
}

// Window bits a brotli stream declares in its header (RFC 7932 section 9.1,
// plus the large-window extension), or undefined while `header` is too short
// to tell. The window is 2^bits - 16 bytes.
function brotliWindowBits(header)
{
	if (header.length === 0)
	{
		return undefined;
	}

	const first = header[0];

	if ((first & 0x01) === 0)
	{
		return 16;
	}

	const standardBits = (first >> 1) & 0x07;

	if (standardBits !== 0)
	{
		return 17 + standardBits;
	}

	const smallBits = (first >> 4) & 0x07;

	if (smallBits !== 1)
	{
		return smallBits === 0 ? 17 : 8 + smallBits;
	}

	// Large-window marker: one reserved bit (the decoder rejects it when set),
	// then the window bits in the next six.
	if (header.length < 2)
	{
		return undefined;
	}

	return header[1] & 0x3f;
}

// Brotli decoder for stored files. Its large-window flag lets a stream declare a
// window up to 2^30, but the download budget assumes at most 2^28, so a larger
// declaration is rejected from the first two bytes, before any data reaches
// the decoder. Standard streams (window <= 24) pass the check unchanged.
class LimitedWindowBrotliDecompress extends zlib.BrotliDecompress
{
	// Header bytes held back until the window bits can be read; null once checked.
	#header = Buffer.alloc(0);

	constructor()
	{
		super({ params: { [zlib.constants.BROTLI_DECODER_PARAM_LARGE_WINDOW]: 1 } });
	}

	_transform(chunk, encoding, callback)
	{
		if (this.#header === null)
		{
			super._transform(chunk, encoding, callback);

			return;
		}

		const header = Buffer.concat([this.#header, chunk]);
		const windowBits = brotliWindowBits(header);

		if (windowBits === undefined)
		{
			this.#header = header;
			callback();

			return;
		}

		this.#header = null;

		if (windowBits > BROTLI_MAX_WINDOW_LOG)
		{
			callback(new RangeError(`Brotli window of ${windowBits} bits exceeds the limit of ${BROTLI_MAX_WINDOW_LOG}`));

			return;
		}

		super._transform(header, encoding, callback);
	}

	_flush(callback)
	{
		// The input ended inside the header: let the decoder report the truncated stream.
		if (this.#header !== null && this.#header.length > 0)
		{
			const header = this.#header;

			this.#header = null;
			super._transform(header, "buffer", (err) =>
			{
				if (err)
				{
					callback(err);

					return;
				}

				super._flush(callback);
			});

			return;
		}

		// No byte ever arrived: pass through so the native decoder sees the end of
		// the input and fails like a stock decoder does.
		this.#header = null;
		super._flush(callback);
	}
}

// Decodes stored bytes. The limits are explicit so frames written by the
// archiver worker (zstd window 28, large-window brotli) decode, while a zstd
// frame asking for a larger window is still rejected, as is a brotli stream
// declaring a window above 2^28. Old objects (zstd window
// <= 27, standard brotli) decode unchanged.
export function createDecompressStream(method)
{
	if (method === COMPRESSION_METHODS.zstd)
	{
		return zlib.createZstdDecompress({
			params: { [zlib.constants.ZSTD_d_windowLogMax]: ZSTD_MAX_WINDOW_LOG },
		});
	}

	if (method === COMPRESSION_METHODS.brotli)
	{
		// Also decodes standard (RFC 7932) streams.
		return new LimitedWindowBrotliDecompress();
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
