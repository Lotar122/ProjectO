"use server";

import { GetObjectCommand } from "@aws-sdk/client-s3";

import { verifyFileOwnership } from "@/app/server-functions/MinIO/verifyFileOwnership";

export async function getFile(s3, bucket, fileKey)
{
	await verifyFileOwnership(fileKey);

	const response = await s3.send(
		new GetObjectCommand({
			Bucket: bucket,
			Key: fileKey,
		})
	);

	// Convert stream to buffer
	const chunks = [];
	for await (const chunk of response.Body)
	{
		chunks.push(chunk);
	}
	const buffer = Buffer.concat(chunks);

	return {
		data: buffer,
		contentType: response.ContentType,
		metadata: response.Metadata
	};
}
