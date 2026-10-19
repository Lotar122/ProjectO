import "server-only";

import { GetObjectCommand } from "@aws-sdk/client-s3";


// Callers must check access first (see verifyFileOwnership.js); this no longer
// re-authenticates, which cost an extra Kratos + DB round trip per file.
// `body` is a Node Readable: stream it, don't buffer it. Destroy it when the
// consumer goes away, or the S3 connection stays open.
export async function getFile(s3, bucket, fileKey, abortSignal)
{
	const response = await s3.send(
		new GetObjectCommand({
			Bucket: bucket,
			Key: fileKey,
		}),
		{ abortSignal },
	);

	return {
		body: response.Body,
		contentLength: response.ContentLength,
		contentType: response.ContentType,
		metadata: response.Metadata,
	};
}
