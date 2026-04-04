"use server";

import { S3Client, HeadBucketCommand } from "@aws-sdk/client-s3";

export async function createS3Client() {
	const s3 = new S3Client({
		region: "us-east-1", // can be any value
		endpoint: "https://localhost:9000", // MinIO API
		credentials: {
			accessKeyId: process.env.MINIO_ROOT,
			secretAccessKey: process.env.MINIO_PASSWORD,
		},
		forcePathStyle: true, // required for MinIO
	});

	return s3;
}
