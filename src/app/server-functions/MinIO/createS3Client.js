import { S3Client } from "@aws-sdk/client-s3";
import { NodeHttpHandler } from "@aws-sdk/node-http-handler";
import http from "http";
import https from "https";

// Shared across requests so sockets are reused instead of a new client
// (and connection) per request. Kept on globalThis for dev-mode hot reloads.
const globalForS3 = globalThis;

export async function createS3Client()
{
	globalForS3.__projectoS3 ??= new S3Client({
		endpoint: process.env.MINIO_ENDPOINT,
		region: 'us-east-1',
		credentials: {
			accessKeyId: process.env.MINIO_ACCESS_KEY,
			secretAccessKey: process.env.MINIO_SECRET_KEY,
		},
		forcePathStyle: true,
		requestHandler: new NodeHttpHandler({
			connectionTimeout: 5000,
			requestTimeout: 30000,
			httpAgent: new http.Agent({ keepAlive: true }),
			httpsAgent: new https.Agent({
				keepAlive: true,
				rejectUnauthorized: false
			})
		})
	});

	return globalForS3.__projectoS3;
}
