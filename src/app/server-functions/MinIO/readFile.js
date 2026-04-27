"use server";

import { GetObjectCommand } from "@aws-sdk/client-s3";

import { verifyFileOwnership } from "@/app/server-functions/MinIO/verifyFileOwnership";

async function readFile(s3, bucket, key) {
	await verifyFileOwnership(key);

	const res = await s3.send(
		new GetObjectCommand({ Bucket: bucket, Key: key }),
	);
	const chunks = [];
	for await (const chunk of res.Body) chunks.push(chunk);
	return Buffer.concat(chunks).toString();
}

export { readFile };
