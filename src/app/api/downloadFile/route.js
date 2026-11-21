import { getUserAuthSession } from "@/app/server-functions/getUserAuthSession";
import {
	ChecksumMismatchError,
	createChecksumVerifyStream,
	isSha256Hex,
} from "@/app/server-functions/MinIO/checksum";
import { createS3Client } from "@/app/server-functions/MinIO/createS3Client";
import { getFile } from "@/app/server-functions/MinIO/getFile";
import { decodeMetadataValue } from "@/app/server-functions/MinIO/metadataEncoding";
import { canAccessFile } from "@/app/server-functions/MinIO/verifyFileOwnership";
import {
	ARCHIVE_META,
	createDecompressStream,
	isCompressed,
} from "@/app/server-functions/orders/fileCompression";
import {
	DECODE_WAIT_MS,
	createDecodeBudget,
	decodeWeight,
	parseDecodeBudgetMiB,
} from "@/app/server-functions/orders/downloadDecodeBudget";
import {
	ORDER_FILES_BUCKET,
	setOrderFileChecksum,
} from "@/app/server-functions/orders/orderFiles";
import { cookies } from "next/headers";
import { createHash } from "node:crypto";
import { Readable, Transform, pipeline } from "node:stream";
import { internalError, jsonError } from "@/app/lib/apiErrors";
import { SemaphoreTimeoutError } from "@/app/lib/concurrency";
import { isUuid } from "@/app/lib/validate";
import { withRequestLogging } from "@/app/lib/withRequestLogging";
import { createLogger } from "@/app/lib/logger";

const log = createLogger("files");

// Bounds the memory of decodes running at the same time (one window per download).
// A bad DOWNLOAD_DECODE_BUDGET_MIB throws when this module loads, so every download
// then fails with a 500 until the value is fixed.
const decodeBudget = createDecodeBudget(parseDecodeBudgetMiB(process.env.DOWNLOAD_DECODE_BUDGET_MIB));

// Browsers show non-ASCII names through filename*; this is the fallback for clients that ignore it.
const toAsciiFileName = (name) => name.replace(/[^\x20-\x7e]|["\\]/g, "_");

// RFC 8187 value for filename*. encodeURIComponent leaves ' ( ) * unescaped,
// which are not attr-chars there; a ' would end the charset/language prefix early.
const toExtendedFileName = (name) => encodeURIComponent(name)
	.replace(/['()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);

// Files uploaded before checksumming have none stored. Hash them while they
// stream to the user and store the result afterwards, off the request path.
function backfillChecksumWhileStreaming(s3, fileKey, body)
{
	const hash = createHash("sha256");
	const tap = new Transform({
		transform(chunk, encoding, callback)
		{
			hash.update(chunk);
			callback(null, chunk);
		},
		flush(callback)
		{
			callback();
			setOrderFileChecksum(s3, fileKey, hash.digest("hex"))
				.then(() => log.info(`Backfilled checksum for legacy file ${fileKey}`))
				.catch((err) => log.warn(`Could not backfill checksum for ${fileKey}: ${err.message}`));
		},
	});

	pipeline(body, tap, ignoreStreamError);

	return tap;
}

// pipeline() needs a callback; failures are handled where the stream is consumed.
function ignoreStreamError()
{
}

// Archived files are stored compressed; the client gets the original bytes.
function decompressWhileStreaming(method, body)
{
	const decompressed = createDecompressStream(method);

	pipeline(body, decompressed, ignoreStreamError);

	return decompressed;
}

// Checks the bytes sent to the client (after decompression) against the stored
// checksum. On a mismatch the stream fails before its last chunk, so the
// client gets a broken transfer instead of silently corrupted content.
function verifyWhileStreaming(fileKey, content, expected)
{
	const verifier = createChecksumVerifyStream(fileKey, expected);

	pipeline(content, verifier, (err) =>
	{
		if (err instanceof ChecksumMismatchError)
		{
			log.error(`Download of ${fileKey} failed checksum verification`, err);
		}
	});

	return verifier;
}

// Size of the original bytes, or undefined when the metadata has no valid one.
function parseOriginalSize(value)
{
	if (typeof value !== "string" || !/^\d+$/.test(value))
	{
		return undefined;
	}

	const size = Number(value);

	return Number.isSafeInteger(size) ? size : undefined;
}

async function handleGet(req)
{
	try 
	{
		const { searchParams } = new URL(req.url);
		const fileKey = searchParams.get("file_id");

		if (!isUuid(fileKey))
		{
			return jsonError("A valid file_id is required", 400);
		}

		// Auth check
		const cookieHeader = await cookies();
		const userAuthSession = await getUserAuthSession(cookieHeader);

		if (!userAuthSession.loggedIn)
		{
			return jsonError("Forbidden", 403);
		}

		if (!(await canAccessFile(userAuthSession, fileKey)))
		{
			return jsonError("File not found", 404);
		}

		const s3 = await createS3Client();

		// Streamed to the client instead of buffered; the client checks the stored checksum.
		const file = await getFile(s3, ORDER_FILES_BUCKET, fileKey, req.signal);
		// A malformed value is treated as missing, so it gets backfilled.
		const storedChecksum = isSha256Hex(file.metadata?.[ARCHIVE_META.sha256]) ?
			file.metadata[ARCHIVE_META.sha256] :
			undefined;
		const compressed = isCompressed(file.metadata);
		const originalSize = parseOriginalSize(file.metadata?.[ARCHIVE_META.originalSize]);
		// Holds this download's share of the decode budget; null when nothing is decoded.
		let releaseDecode = null;

		try
		{
			if (compressed)
			{
				releaseDecode = await decodeBudget.acquire(
					decodeWeight(file.metadata[ARCHIVE_META.method], originalSize),
					{ signal: req.signal, timeoutMs: DECODE_WAIT_MS },
				);
			}

			const content = compressed ?
				decompressWhileStreaming(file.metadata[ARCHIVE_META.method], file.body) :
				file.body;
			const contentLength = compressed ? originalSize : file.contentLength;
			// The archiver always stores a checksum, so compressed files are verified.
			const body = storedChecksum ?
				verifyWhileStreaming(fileKey, content, { sha256: storedChecksum, size: contentLength }) :
				backfillChecksumWhileStreaming(s3, fileKey, content);
			const fileName = decodeMetadataValue(file.metadata?.original_name) ?? "file";

			if (releaseDecode)
			{
				// Whichever of these comes first gives the budget back; the release
				// function ignores every later call, so it is freed exactly once.
				content.once("close", releaseDecode);
				body.once("close", releaseDecode);
			}

			// The abort event only fires once; a client that already left would keep
			// the S3 body open forever. 499: the client is gone, this just labels the access log.
			if (req.signal.aborted)
			{
				body.destroy();
				releaseDecode?.();

				return new Response(null, { status: 499 });
			}

			req.signal.addEventListener("abort", () =>
			{
				body.destroy();
				releaseDecode?.();
			}, { once: true });

			return new Response(Readable.toWeb(body), {
				status: 200,
				headers: {
					"Content-Type": file.contentType ?? "application/octet-stream",
					...(contentLength === undefined ? {} : { "Content-Length": String(contentLength) }),
					"Content-Disposition": `attachment; filename="${toAsciiFileName(fileName)}"; filename*=UTF-8''${toExtendedFileName(fileName)}`,
					"Cache-Control": "private, no-store",
					"X-Content-Type-Options": "nosniff",
					...(storedChecksum ? { "X-Content-SHA256": storedChecksum } : {}),
				},
			});
		}
		catch (err)
		{
			// Nothing will read the S3 body any more, and the budget must not stay held.
			releaseDecode?.();
			file.body.destroy();

			if (err instanceof SemaphoreTimeoutError)
			{
				log.warn(`Download of ${fileKey} waited ${DECODE_WAIT_MS} ms for decode budget`);

				return Response.json(
					{ success: false, error: "Serwer jest chwilowo przeciążony. Spróbuj ponownie za kilka sekund." },
					{ status: 503, headers: { "Retry-After": "5" } },
				);
			}

			throw err;
		}
	}
	catch (err)
	{
		// The client left while S3 was still answering; getFile rejects with the
		// abort. Nobody is waiting for a 500, and it is not a server error.
		if (req.signal.aborted)
		{
			return new Response(null, { status: 499 });
		}

		log.error("Failed to download file", err);

		return internalError();
	}
}

export const GET = withRequestLogging(handleGet);
