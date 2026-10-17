import "server-only";

import { GetObjectCommand } from "@aws-sdk/client-s3";


// Callers must check access first (see verifyFileOwnership.js); this no longer
// re-authenticates, which cost an extra Kratos + DB round trip per file.
async function readFile(s3, bucket, key)
{
	const res = await s3.send(
		new GetObjectCommand({ Bucket: bucket, Key: key }),
	);
	const chunks = [];
	for await (const chunk of res.Body) chunks.push(chunk);
	return Buffer.concat(chunks).toString();
}

export { readFile };
