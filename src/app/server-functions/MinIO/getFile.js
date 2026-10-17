import "server-only";

import { GetObjectCommand } from "@aws-sdk/client-s3";


// Callers must check access first (see verifyFileOwnership.js); this no longer
// re-authenticates, which cost an extra Kratos + DB round trip per file.
export async function getFile(s3, bucket, fileKey)
{
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
