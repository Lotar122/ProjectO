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
	ORDER_FILES_BUCKET,
	setOrderFileChecksum,
} from "@/app/server-functions/orders/orderFiles";
import { cookies } from "next/headers";
import { createHash } from "node:crypto";
import { Readable, Transform, pipeline } from "node:stream";
import { internalError, jsonError } from "@/app/lib/apiErrors";
import { isUuid } from "@/app/lib/validate";
import { withRequestLogging } from "@/app/lib/withRequestLogging";
import { createLogger } from "@/app/lib/logger";

const log = createLogger("files");

// Browsers show non-ASCII names through filename*; this is the fallback for clients that ignore it.
const toAsciiFileName = (name) => name.replace(/[^\x20-\x7e]|["\\]/g, "_");

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
		const content = compressed ?
			decompressWhileStreaming(file.metadata[ARCHIVE_META.method], file.body) :
			file.body;
		const contentLength = compressed ?
			parseOriginalSize(file.metadata[ARCHIVE_META.originalSize]) :
			file.contentLength;
		// The archiver always stores a checksum, so compressed files are verified.
		const body = storedChecksum ?
			verifyWhileStreaming(fileKey, content, { sha256: storedChecksum, size: contentLength }) :
			backfillChecksumWhileStreaming(s3, fileKey, content);
		const fileName = decodeMetadataValue(file.metadata?.original_name) ?? "file";

		// The abort event only fires once; a client that already left would keep
		// the S3 body open forever. 499: the client is gone, this just labels the access log.
		if (req.signal.aborted)
		{
			body.destroy();

			return new Response(null, { status: 499 });
		}

		req.signal.addEventListener("abort", () => body.destroy(), { once: true });

		return new Response(Readable.toWeb(body), {
			status: 200,
			headers: {
				"Content-Type": file.contentType ?? "application/octet-stream",
				...(contentLength === undefined ? {} : { "Content-Length": String(contentLength) }),
				"Content-Disposition": `attachment; filename="${toAsciiFileName(fileName)}"; filename*=UTF-8''${encodeURIComponent(fileName)}`,
				"Cache-Control": "private, no-store",
				"X-Content-Type-Options": "nosniff",
				...(storedChecksum ? { "X-Content-SHA256": storedChecksum } : {}),
			},
		});

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
