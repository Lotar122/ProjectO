import "server-only";

import { DeleteObjectCommand } from "@aws-sdk/client-s3";

import { createLogger } from "@/app/lib/logger";

const log = createLogger("minio");

// Callers must check access first (see verifyFileOwnership.js); this no longer
// re-authenticates, which cost an extra Kratos + DB round trip per file.
/**
 * Deletes a file from MinIO by its object ID/key.
 * @param {import("@aws-sdk/client-s3").S3Client} s3
 * @param {string} bucket - Bucket name, e.g. "projecto"
 * @param {string} fileId - Object key / file ID stored in MinIO
 */
export async function deleteFileById(s3, bucket, fileId)
{
	try 
	{
		await s3.send(
			new DeleteObjectCommand({
				Bucket: bucket,
				Key: fileId,
			}),
		);

		return {
			success: true,
			message: `File ${fileId} deleted from ${bucket}`,
		};
	}
	catch (err) 
	{
		log.error(`Failed to delete file ${fileId} from bucket "${bucket}"`, err);
		return { success: false, error: err.message };
	}
}

export async function deleteFileFromMinio(s3, bucket, fileId)
{
	return deleteFileById(s3, bucket, fileId);
}
