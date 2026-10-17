import "server-only";

import { HeadBucketCommand, CreateBucketCommand } from "@aws-sdk/client-s3";

import { createLogger } from "@/app/lib/logger";

const log = createLogger("minio");

export async function createBucket(s3, bucketName)
{
	try
	{
		// Check if exists
		await s3.send(new HeadBucketCommand({ Bucket: bucketName }));
		return false;
	}
	catch (err)
	{
		// 404 just means the bucket has to be created below.
		if (err.$metadata?.httpStatusCode !== 404)
		{
			log.error(`HeadBucket "${bucketName}" failed: ${err.message}`, err.$metadata);
			throw err;
		}
	}

	// Create if not exists
	await s3.send(
		new CreateBucketCommand({
			Bucket: bucketName,
		}),
	);

	log.info(`Bucket "${bucketName}" created`);
	return true;
}
