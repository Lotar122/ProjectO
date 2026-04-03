"use server";

async function readFile(bucket, key) {
	const res = await s3.send(
		new GetObjectCommand({ Bucket: bucket, Key: key }),
	);
	const chunks = [];
	for await (const chunk of res.Body) chunks.push(chunk);
	return Buffer.concat(chunks).toString();
}
