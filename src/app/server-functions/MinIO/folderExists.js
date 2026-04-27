"use server";

async function folderExists(s3, bucket, prefix)
{
	const res = await s3.send(
		new ListObjectsV2Command({
			Bucket: bucket,
			Prefix: prefix.endsWith("/") ? prefix : prefix + "/",
			MaxKeys: 1,
		}),
	);
	return res.KeyCount > 0;
}
