"use server";

import { createS3Client } from "@/app/server-functions/MinIO/createS3Client";
import { DeleteObjectCommand } from "@aws-sdk/client-s3";

/**
 * Deletes a file from MinIO given its UUID (object key)
 * @param {string} bucketName - name of the bucket, e.g., 'projecto'
 * @param {string} fileUUID - the object key / UUID of the file
 */
export async function deleteFileFromMinio(s3, bucketName, fileUUID) {
  try {
    await s3.send(
      new DeleteObjectCommand({
        Bucket: bucketName,
        Key: fileUUID,
      })
    );

    return { success: true, message: `File ${fileUUID} deleted from ${bucketName}` };
  } catch (err) {
    console.error("Failed to delete file from MinIO:", err);
    return { success: false, error: err.message };
  }
}