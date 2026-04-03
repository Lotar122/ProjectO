"use server";

import { S3Client, HeadBucketCommand } from "@aws-sdk/client-s3";

export async function getS3Client()
{
    const s3 = new S3Client({
        region: "us-east-1", // can be any value
        endpoint: "http://localhost:9000", // MinIO API
        credentials: {
            accessKeyId: "minioadmin",
            secretAccessKey: "minioadmin",
        },
        forcePathStyle: true, // required for MinIO
    });

    return s3;
}