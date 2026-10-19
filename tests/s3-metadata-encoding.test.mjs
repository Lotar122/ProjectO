import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import {
	encodeMetadataValue,
	decodeMetadataValue,
} from "../src/app/server-functions/MinIO/metadataEncoding.js";

const NAME = "zdjęcie 🎉.png";

async function withServer(fn)
{
	let received;
	const server = http.createServer((req, res) =>
	{
		received = req.headers;
		req.resume();
		req.on("end", () => res.writeHead(200).end());
	});
	await new Promise((r) => server.listen(0, "127.0.0.1", r));
	const s3 = new S3Client({
		region: "us-east-1",
		endpoint: `http://127.0.0.1:${server.address().port}`,
		forcePathStyle: true,
		credentials: { accessKeyId: "a", secretAccessKey: "b" },
	});
	try { await fn(s3); return received; }
	finally { s3.destroy(); server.close(); }
}

const put = (s3, value) => s3.send(new PutObjectCommand({
	Bucket: "b", Key: "k", Body: "x", Metadata: { original_name: value },
}));

test("raw non-ASCII metadata is rejected (reproduces the bug)", async () =>
{
	await assert.rejects(withServer((s3) => put(s3, NAME)));
});

test("encoded metadata uploads and round-trips", async () =>
{
	const headers = await withServer((s3) => put(s3, encodeMetadataValue(NAME)));
	assert.equal(decodeMetadataValue(headers["x-amz-meta-original_name"]), NAME);
});

test("decode tolerates legacy raw values", () =>
{
	assert.equal(decodeMetadataValue("plain name.stl"), "plain name.stl");
	assert.equal(decodeMetadataValue("100%.stl"), "100%.stl");
	assert.equal(decodeMetadataValue(undefined), undefined);
});
