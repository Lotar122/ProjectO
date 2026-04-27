"use server";

import { HeadObjectCommand } from "@aws-sdk/client-s3";

import { verifyFileOwnership } from "@/app/server-functions/MinIO/verifyFileOwnership";

export async function getFileMetadata(s3, bucket, key)
{
	await verifyFileOwnership(key);

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
