"use server";

import { HeadObjectCommand } from "@aws-sdk/client-s3";
import { createS3Client } from "@/app/server-functions/MinIO/createS3Client";

export async function getFileMetadata(s3, bucket, key) {
  const res = await s3.send(
    new HeadObjectCommand({
      Bucket: bucket,
      Key: key,
    })
  );

  return {
    size: res.ContentLength,
    contentType: res.ContentType,
    lastModified: res.LastModified,
    metadata: res.Metadata,
  };
}
