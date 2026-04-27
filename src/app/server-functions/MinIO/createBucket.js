"use server";

import { HeadBucketCommand, CreateBucketCommand } from "@aws-sdk/client-s3";

export async function createBucket(s3, bucketName)
{
	try {
		// Check if exists
		await s3.send(new HeadBucketCommand({ Bucket: bucketName }));
		console.log(`Bucket "${bucketName}" already exists`);
		return false;
	} catch (err) {
		console.error('createBucket error:', err.$metadata, err.message, err.Code);
		if (err.$metadata?.httpStatusCode !== 404)
		{
			throw err;
		}
	}

	// Create if not exists
	await s3.send(
		new CreateBucketCommand({
			Bucket: bucketName,
		}),
	);

	console.log(`Bucket "${bucketName}" created`);
	return true;
}
