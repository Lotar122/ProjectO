import "server-only";

import { HeadObjectCommand } from "@aws-sdk/client-s3";


// Callers must check access first (see verifyFileOwnership.js); this no longer
// re-authenticates, which cost an extra Kratos + DB round trip per file.
export async function getFileMetadata(s3, bucket, key)
{
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
