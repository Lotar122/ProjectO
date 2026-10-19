import "server-only";

import { S3Client } from "@aws-sdk/client-s3";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import http from "http";
import https from "https";

const MAX_SOCKETS = 50;

// Shared across requests so sockets are reused instead of a new client
// (and connection) per request. Kept on globalThis for dev-mode hot reloads.
const globalForS3 = globalThis;

// socketTimeout is an idle timeout, so large transfers can take as long as
// they keep moving, while a silent MinIO fails after 30s instead of hanging.
// MinIO runs on the Docker internal network with a self-signed certificate,
// so certificate verification is disabled for it.
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
		maxAttempts: 2,
		requestHandler: new NodeHttpHandler({
			connectionTimeout: 5000,
			socketTimeout: 30000,
			httpAgent: new http.Agent({ keepAlive: true, maxSockets: MAX_SOCKETS }),
			httpsAgent: new https.Agent({
				keepAlive: true,
				maxSockets: MAX_SOCKETS,
				rejectUnauthorized: false,
			}),
		}),
	});

	return globalForS3.__projectoS3;
}
