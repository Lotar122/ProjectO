// S3 stand-in served over HTTP, so a real S3Client (and lib-storage's Upload)
// talks to it exactly as it would to MinIO. Shared by the archiver tests.

import http from "node:http";
import { createHash } from "node:crypto";
import { S3Client } from "@aws-sdk/client-s3";

function metadataFromHeaders(headers)
{
	const metadata = {};

	for (const [name, value] of Object.entries(headers))
	{
		if (name.startsWith("x-amz-meta-"))
		{
			metadata[name.slice("x-amz-meta-".length)] = value;
		}
	}

	return metadata;
}

const md5Etag = (body) => `"${createHash("md5").update(body).digest("hex")}"`;

// Like S3/MinIO: the ETag follows the content, so a metadata-only copy keeps it.
const etagOf = (object) => object.etag ?? md5Etag(object.body);

function objectHeaders(object)
{
	return {
		"Content-Length": String(object.body.length),
		"Content-Type": object.contentType ?? "application/octet-stream",
		ETag: etagOf(object),
		...Object.fromEntries(Object.entries(object.metadata).map(([name, value]) => [`x-amz-meta-${name}`, value])),
	};
}

function sendNotFound(req, res)
{
	if (req.method === "HEAD")
	{
		res.writeHead(404).end();
		return;
	}

	res.writeHead(404, { "Content-Type": "application/xml" }).end(
		"<Error><Code>NoSuchKey</Code><Message>The specified key does not exist.</Message></Error>",
	);
}

function sendError(res, status, code)
{
	res.writeHead(status, { "Content-Type": "application/xml" }).end(
		`<Error><Code>${code}</Code><Message>${code}</Message></Error>`,
	);
}

// Applies an If-Match header to a write of key: false (and the error sent)
// when the current object does not match.
function checkIfMatch(req, res, objects, key, ifMatch, counters)
{
	if (ifMatch === undefined)
	{
		return true;
	}

	const current = objects.get(key);

	if (!current)
	{
		counters.rejected++;
		sendNotFound(req, res);
		return false;
	}

	if (etagOf(current) !== ifMatch)
	{
		counters.rejected++;
		sendError(res, 412, "PreconditionFailed");
		return false;
	}

	return true;
}

// S3 stand-in with Head/Get/Put/Copy (self-copy with REPLACE metadata)/Delete
// and the multipart calls (including ListMultipartUploads with a prefix),
// built like withS3 in multipart-upload.test.mjs. PutObject and
// CompleteMultipartUpload honour If-Match, CopyObject honours
// x-amz-copy-source-if-match. fn also gets the open multipart uploads
// (uploadId -> { key, parts }), which a test may seed.
// corruptPuts: number of following PutObject bodies to store with a flipped byte.
// beforePut / beforeCopy({ objects, key, index }): called before the request
//   is handled (index counts from 0); may change objects, or return an HTTP
//   status to fail the request with.
export async function withS3(fn, { corruptPuts = 0, beforePut, beforeCopy } = {})
{
	const objects = new Map();
	const multipart = new Map();
	const counters = { put: 0, copy: 0, delete: 0, rejected: 0, putAttempts: 0, copyAttempts: 0 };
	const requests = [];
	let corruptRemaining = corruptPuts;

	const server = http.createServer((req, res) =>
	{
		const chunks = [];

		req.on("data", (chunk) => chunks.push(chunk));
		req.on("end", () =>
		{
			const url = new URL(req.url, "http://localhost");
			const key = decodeURIComponent(url.pathname.split("/").slice(2).join("/"));
			const requestBody = Buffer.concat(chunks);

			requests.push({ method: req.method, search: url.search, headers: req.headers });

			if (req.method === "POST" && url.searchParams.has("uploads"))
			{
				multipart.set("u1", {
					key,
					contentType: req.headers["content-type"],
					metadata: metadataFromHeaders(req.headers),
					parts: new Map(),
				});
				res.writeHead(200, { "Content-Type": "application/xml" }).end(
					"<InitiateMultipartUploadResult><UploadId>u1</UploadId></InitiateMultipartUploadResult>",
				);
				return;
			}

			if (req.method === "GET" && url.searchParams.has("uploads"))
			{
				const prefix = url.searchParams.get("prefix") ?? "";
				const uploads = [...multipart.entries()]
					.filter(([, upload]) => upload.key.startsWith(prefix))
					.map(([uploadId, upload]) => `<Upload><Key>${upload.key}</Key><UploadId>${uploadId}</UploadId></Upload>`);

				res.writeHead(200, { "Content-Type": "application/xml" }).end(
					`<ListMultipartUploadsResult><Bucket>projecto</Bucket><Prefix>${prefix}</Prefix>` +
					`<IsTruncated>false</IsTruncated>${uploads.join("")}</ListMultipartUploadsResult>`,
				);
				return;
			}

			if (req.method === "PUT" && url.searchParams.has("partNumber"))
			{
				multipart.get(url.searchParams.get("uploadId")).parts.set(
					Number(url.searchParams.get("partNumber")),
					requestBody,
				);
				res.writeHead(200, { ETag: `"part${url.searchParams.get("partNumber")}"` }).end();
				return;
			}

			if (req.method === "POST" && url.searchParams.has("uploadId"))
			{
				const upload = multipart.get(url.searchParams.get("uploadId"));

				if (!checkIfMatch(req, res, objects, upload.key, req.headers["if-match"], counters))
				{
					return;
				}

				const body = Buffer.concat([...upload.parts.entries()].sort((a, b) => a[0] - b[0]).map(([, part]) => part));
				const etag = `"${createHash("md5").update(body).digest("hex")}-${upload.parts.size}"`;

				counters.put++;
				multipart.delete(url.searchParams.get("uploadId"));
				objects.set(upload.key, { body, etag, contentType: upload.contentType, metadata: upload.metadata });
				res.writeHead(200, { "Content-Type": "application/xml" }).end(
					`<CompleteMultipartUploadResult><ETag>${etag.replaceAll("\"", "&quot;")}</ETag></CompleteMultipartUploadResult>`,
				);
				return;
			}

			if (req.method === "DELETE" && url.searchParams.has("uploadId"))
			{
				multipart.delete(url.searchParams.get("uploadId"));
				res.writeHead(204).end();
				return;
			}

			if (req.method === "PUT" && req.headers["x-amz-copy-source"])
			{
				const failStatus = beforeCopy?.({ objects, key, index: counters.copyAttempts++ });

				if (failStatus)
				{
					sendError(res, failStatus, "InternalError");
					return;
				}

				const sourceKey = decodeURIComponent(req.headers["x-amz-copy-source"].split("/").slice(1).join("/"));
				const source = objects.get(sourceKey);

				if (!source)
				{
					sendNotFound(req, res);
					return;
				}

				const copyIfMatch = req.headers["x-amz-copy-source-if-match"];

				if (copyIfMatch !== undefined && copyIfMatch !== etagOf(source))
				{
					counters.rejected++;
					sendError(res, 412, "PreconditionFailed");
					return;
				}

				const replace = req.headers["x-amz-metadata-directive"] === "REPLACE";
				const etag = etagOf(source);

				counters.copy++;
				objects.set(key, {
					body: source.body,
					etag,
					contentType: replace ? req.headers["content-type"] : source.contentType,
					metadata: replace ? metadataFromHeaders(req.headers) : { ...source.metadata },
				});
				res.writeHead(200, { "Content-Type": "application/xml" }).end(
					`<CopyObjectResult><ETag>${etag.replaceAll("\"", "&quot;")}</ETag></CopyObjectResult>`,
				);
				return;
			}

			if (req.method === "PUT")
			{
				const failStatus = beforePut?.({ objects, key, index: counters.putAttempts++ });

				if (failStatus)
				{
					sendError(res, failStatus, "InternalError");
					return;
				}

				if (!checkIfMatch(req, res, objects, key, req.headers["if-match"], counters))
				{
					return;
				}

				let body = requestBody;

				if (corruptRemaining > 0)
				{
					corruptRemaining--;
					body = Buffer.from(body);
					body[body.length - 1] ^= 0xff;
				}

				counters.put++;
				objects.set(key, {
					body,
					contentType: req.headers["content-type"],
					metadata: metadataFromHeaders(req.headers),
				});
				res.writeHead(200, { ETag: md5Etag(body) }).end();
				return;
			}

			if (req.method === "HEAD" || req.method === "GET")
			{
				const object = objects.get(key);

				if (!object)
				{
					sendNotFound(req, res);
					return;
				}

				res.writeHead(200, objectHeaders(object));
				res.end(req.method === "GET" ? object.body : undefined);
				return;
			}

			if (req.method === "DELETE")
			{
				counters.delete++;
				objects.delete(key);
				res.writeHead(204).end();
				return;
			}

			res.writeHead(400).end();
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
		await fn(s3, { objects, counters, requests, multipart });
	}
	finally
	{
		s3.destroy();
		server.close();
	}
}
