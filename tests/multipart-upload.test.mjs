import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createHash } from "node:crypto";
import { S3Client } from "@aws-sdk/client-s3";
import {
	InvalidUploadError,
	UploadLimitError,
	receiveOrderUpload,
} from "../src/app/server-functions/orders/multipartUpload.js";
import { ChecksumMismatchError } from "../src/app/server-functions/MinIO/checksum.js";

const sha = (text) => createHash("sha256").update(text).digest("hex");

// Minimal S3 stand-in: stores PUT bodies (including multipart uploads) and honours DeleteObjects.
async function withS3(fn)
{
	const objects = new Map();
	const multipart = new Map();
	let putCount = 0;
	const server = http.createServer((req, res) =>
	{
		const chunks = [];

		req.on("data", (chunk) => chunks.push(chunk));
		req.on("end", () =>
		{
			const url = new URL(req.url, "http://localhost");
			const key = url.pathname.split("/").slice(2).join("/");

			if (req.method === "POST" && url.searchParams.has("uploads"))
			{
				multipart.set("u1", { key, metadata: req.headers, parts: new Map() });
				res.writeHead(200, { "Content-Type": "application/xml" }).end(
					"<InitiateMultipartUploadResult><UploadId>u1</UploadId></InitiateMultipartUploadResult>",
				);
				return;
			}

			if (req.method === "PUT" && url.searchParams.has("partNumber"))
			{
				putCount++;
				multipart.get(url.searchParams.get("uploadId")).parts.set(
					Number(url.searchParams.get("partNumber")),
					Buffer.concat(chunks),
				);
				res.writeHead(200, { ETag: `"part${url.searchParams.get("partNumber")}"` }).end();
				return;
			}

			if (req.method === "POST" && url.searchParams.has("uploadId"))
			{
				const upload = multipart.get(url.searchParams.get("uploadId"));
				const body = Buffer.concat([...upload.parts.entries()].sort((a, b) => a[0] - b[0]).map(([, part]) => part));

				objects.set(upload.key, { body, metadata: upload.metadata });
				res.writeHead(200, { "Content-Type": "application/xml" }).end(
					"<CompleteMultipartUploadResult><ETag>\"done\"</ETag></CompleteMultipartUploadResult>",
				);
				return;
			}

			if (req.method === "DELETE" && url.searchParams.has("uploadId"))
			{
				multipart.delete(url.searchParams.get("uploadId"));
				res.writeHead(204).end();
				return;
			}

			if (req.method === "PUT")
			{
				putCount++;
				objects.set(key, { body: Buffer.concat(chunks), metadata: req.headers });
				res.writeHead(200, { ETag: '"etag"' }).end();
				return;
			}

			if (req.method === "POST" && url.searchParams.has("delete"))
			{
				const xml = Buffer.concat(chunks).toString();

				for (const [, deletedKey] of xml.matchAll(/<Key>([^<]+)<\/Key>/g))
				{
					objects.delete(deletedKey);
				}

				res.writeHead(200, { "Content-Type": "application/xml" }).end("<DeleteResult></DeleteResult>");
				return;
			}

			res.writeHead(200).end();
		});
	});

	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

	const s3 = new S3Client({
		region: "us-east-1",
		endpoint: `http://127.0.0.1:${server.address().port}`,
		forcePathStyle: true,
		credentials: { accessKeyId: "a", secretAccessKey: "b" },
		maxAttempts: 1,
	});

	try
	{
		await fn(s3, { objects, getPutCount: () => putCount });
	}
	finally
	{
		s3.destroy();
		server.close();
	}
}

function buildRequest(entries)
{
	const formData = new FormData();

	for (const [name, value, fileName] of entries)
	{
		if (fileName)
		{
			formData.append(name, new File([value], fileName));
		}
		else
		{
			formData.append(name, value);
		}
	}

	return new Request("http://localhost/api/postOrder", { method: "POST", body: formData });
}

test("streams files to S3 and returns fields and file records", async () =>
{
	await withS3(async (s3, { objects }) =>
	{
		const req = buildRequest([
			["patient", "Jan Kowalski"],
			["details", "Zęby"],
			["fileChecksums", sha("alpha")],
			["fileChecksums", sha("beta")],
			["files", "alpha", "upper-jan-kowalski.stl"],
			["files", "beta", "notes.txt"],
		]);
		const { fields, files } = await receiveOrderUpload(req, s3);

		assert.equal(fields.get("patient"), "Jan Kowalski");
		assert.equal(fields.get("details"), "Zęby");
		assert.equal(files.length, 2);
		assert.equal(files[0].fileName, "UpperJawScan.stl");
		assert.equal(files[0].sha256, sha("alpha"));
		assert.equal(objects.size, 2);
		assert.equal(objects.get(files[1].fileID).body.toString(), "beta");
		assert.equal(objects.get(files[1].fileID).metadata["x-amz-meta-sha256"], sha("beta"));
	});
});

test("deletes everything when a checksum does not match", async () =>
{
	await withS3(async (s3, { objects }) =>
	{
		const req = buildRequest([
			["patient", "Jan"],
			["fileChecksums", sha("alpha")],
			["fileChecksums", sha("WRONG")],
			["files", "alpha", "a.txt"],
			["files", "beta", "b.txt"],
		]);

		await assert.rejects(
			receiveOrderUpload(req, s3),
			(err) => err instanceof ChecksumMismatchError && err.files.join() === "b.txt",
		);
		assert.equal(objects.size, 0);
	});
});

test("rejects a file over the per-file limit and leaves nothing behind", async () =>
{
	await withS3(async (s3, { objects }) =>
	{
		const req = buildRequest([
			["patient", "Jan"],
			["fileChecksums", ""],
			["files", "x".repeat(100), "big.bin"],
		]);

		await assert.rejects(
			receiveOrderUpload(req, s3, {
				limits: { maxFiles: 5, maxFileBytes: 10, maxTotalBytes: 1000 },
			}),
			UploadLimitError,
		);
		assert.equal(objects.size, 0);
	});
});

test("rejects too many files", async () =>
{
	await withS3(async (s3, { objects }) =>
	{
		const req = buildRequest([
			["patient", "Jan"],
			["files", "1", "1.txt"],
			["files", "2", "2.txt"],
			["files", "3", "3.txt"],
		]);

		await assert.rejects(
			receiveOrderUpload(req, s3, {
				limits: { maxFiles: 2, maxFileBytes: 1000, maxTotalBytes: 1000 },
			}),
			UploadLimitError,
		);
		assert.equal(objects.size, 0);
	});
});

test("rejects when the total size is exceeded", async () =>
{
	await withS3(async (s3, { objects }) =>
	{
		const req = buildRequest([
			["patient", "Jan"],
			["files", "x".repeat(60), "1.bin"],
			["files", "x".repeat(60), "2.bin"],
		]);

		await assert.rejects(
			receiveOrderUpload(req, s3, {
				limits: { maxFiles: 5, maxFileBytes: 100, maxTotalBytes: 100 },
			}),
			UploadLimitError,
		);
		assert.equal(objects.size, 0);
	});
});

test("validation failure happens before any file is uploaded", async () =>
{
	await withS3(async (s3, { getPutCount }) =>
	{
		const req = buildRequest([
			["patient", ""],
			["files", "alpha", "a.txt"],
		]);

		await assert.rejects(
			receiveOrderUpload(req, s3, {
				validate: (fields) =>
				{
					if (!fields.get("patient"))
					{
						throw new InvalidUploadError("patient required");
					}
				},
			}),
			InvalidUploadError,
		);
		assert.equal(getPutCount(), 0);
	});
});

test("rejects files that arrive before the text fields", async () =>
{
	await withS3(async (s3) =>
	{
		const req = buildRequest([
			["files", "alpha", "a.txt"],
			["patient", "Jan"],
		]);

		await assert.rejects(receiveOrderUpload(req, s3), InvalidUploadError);
	});
});

test("rejects non-multipart bodies", async () =>
{
	await withS3(async (s3) =>
	{
		const req = new Request("http://localhost/x", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: "{}",
		});

		await assert.rejects(receiveOrderUpload(req, s3), InvalidUploadError);
	});
});

test("uploads a file larger than one part through the multipart API", async () =>
{
	await withS3(async (s3, { objects }) =>
	{
		const content = Buffer.alloc(20 * 1024 * 1024, "abcdefghij");
		const checksum = createHash("sha256").update(content).digest("hex");
		const formData = new FormData();

		formData.append("patient", "Jan");
		formData.append("fileChecksums", checksum);
		formData.append("files", new File([content], "scan.stl"));

		const req = new Request("http://localhost/x", { method: "POST", body: formData });
		const { files } = await receiveOrderUpload(req, s3);

		assert.equal(files.length, 1);
		assert.equal(files[0].sha256, checksum);
		assert.equal(
			createHash("sha256").update(objects.get(files[0].fileID).body).digest("hex"),
			checksum,
		);
	});
});
