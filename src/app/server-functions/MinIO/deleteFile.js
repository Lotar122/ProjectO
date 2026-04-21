"use server";

import { DeleteObjectCommand } from "@aws-sdk/client-s3";

/**
 * Deletes a file from MinIO by its object ID/key.
 * @param {import("@aws-sdk/client-s3").S3Client} s3
 * @param {string} bucket - Bucket name, e.g. "projecto"
 * @param {string} fileId - Object key / file ID stored in MinIO
 */
export async function deleteFileById(s3, bucket, fileId) {
	try {
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
	} catch (err) {
		console.error("Failed to delete file from MinIO:", err);
		return { success: false, error: err.message };
	}
}

export async function deleteFileFromMinio(s3, bucket, fileId) {
	return deleteFileById(s3, bucket, fileId);
}
