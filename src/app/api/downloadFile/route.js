import { getUserAuthSession } from "@/app/server-functions/getUserAuthSession";
import { createS3Client } from "@/app/server-functions/MinIO/createS3Client";
import { getFile } from "@/app/server-functions/MinIO/getFile";
import { decodeMetadataValue } from "@/app/server-functions/MinIO/metadataEncoding";
import { canAccessFile } from "@/app/server-functions/MinIO/verifyFileOwnership";
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
		const storedChecksum = file.metadata?.sha256;
		const body = storedChecksum ?
			file.body :
			backfillChecksumWhileStreaming(s3, fileKey, file.body);
		const fileName = decodeMetadataValue(file.metadata?.original_name) ?? "file";

		req.signal.addEventListener("abort", () => body.destroy(), { once: true });

		return new Response(Readable.toWeb(body), {
			status: 200,
			headers: {
				"Content-Type": file.contentType ?? "application/octet-stream",
				...(file.contentLength === undefined ? {} : { "Content-Length": String(file.contentLength) }),
				"Content-Disposition": `attachment; filename="${toAsciiFileName(fileName)}"; filename*=UTF-8''${encodeURIComponent(fileName)}`,
				"Cache-Control": "private, no-store",
				"X-Content-Type-Options": "nosniff",
				...(storedChecksum ? { "X-Content-SHA256": storedChecksum } : {}),
			},
		});

	}
	catch (err) 
	{
		log.error("Failed to download file", err);

		return internalError();
	}
}

export const GET = withRequestLogging(handleGet);
