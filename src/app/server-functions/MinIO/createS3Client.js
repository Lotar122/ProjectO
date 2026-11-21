import "server-only";

import { S3Client } from "@aws-sdk/client-s3";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import http from "http";
import https from "https";
import { readFileSync } from "node:fs";

import { createLogger } from "@/app/lib/logger";

const log = createLogger("s3");

const MAX_SOCKETS = 50;
const TRUE_VALUES = new Set(["1", "true"]);
const FALSE_VALUES = new Set(["", "0", "false"]);

// Shared across requests so sockets are reused instead of a new client
// (and connection) per request. Kept on globalThis for dev-mode hot reloads.
const globalForS3 = globalThis;

// readTlsOptions runs again whenever the cached client is missing (a test, a
// failed creation), so the insecure-mode warning is remembered per process.
let insecureWarningLogged = false;

/** Lets a test see the insecure-mode warning again. Not used by the app. */
export function resetInsecureWarningForTests()
{
	insecureWarningLogged = false;
}

// TLS settings for an https:// MINIO_ENDPOINT. Certificates are always verified
// unless verification is turned off explicitly:
//
//   MINIO_CA_FILE=/path/ca.pem   PEM file with the CA (or CA bundle) that signed
//                                MinIO's certificate, for a self-signed or private
//                                CA. It replaces the system CA list for MinIO
//                                connections only. The certificate must name the
//                                MINIO_ENDPOINT host in its subjectAltName.
//   MINIO_TLS_INSECURE=1         Turns certificate verification off (also "true").
//                                Anyone on the network path can then read and
//                                change the files, so use it only for local
//                                development. Logged as a warning once per process,
//                                when the first client is created.
//
// Neither set: verified against the system CA list. Both set: rejected, since
// the intent is unclear. Both only take effect for an https:// endpoint.
function readTlsOptions(env)
{
	const insecureValue = (env.MINIO_TLS_INSECURE ?? "").trim().toLowerCase();
	const caFile = env.MINIO_CA_FILE?.trim() ?? "";

	if (!TRUE_VALUES.has(insecureValue) && !FALSE_VALUES.has(insecureValue))
	{
		throw new RangeError(`MINIO_TLS_INSECURE must be 1, true, 0, false or empty, got "${env.MINIO_TLS_INSECURE}"`);
	}

	const insecure = TRUE_VALUES.has(insecureValue);

	if (insecure && caFile)
	{
		throw new RangeError("Set either MINIO_CA_FILE or MINIO_TLS_INSECURE, not both");
	}

	if (insecure)
	{
		if (!insecureWarningLogged)
		{
			insecureWarningLogged = true;
			log.warn("MINIO_TLS_INSECURE is set: MinIO TLS certificates are NOT verified");
		}

		return { rejectUnauthorized: false };
	}

	if (caFile)
	{
		try
		{
			return { rejectUnauthorized: true, ca: readFileSync(caFile, "utf8") };
		}
		catch (err)
		{
			throw new Error(`Could not read MINIO_CA_FILE (${caFile}): ${err.message}`, { cause: err });
		}
	}

	return { rejectUnauthorized: true };
}

// socketTimeout is an idle timeout, so large transfers can take as long as
// they keep moving, while a silent MinIO fails after 30s instead of hanging.
export async function createS3Client()
{
	// An http:// endpoint never uses the https agent, so its TLS options are
	// neither read nor validated.
	const isHttps = /^https:\/\//i.test(process.env.MINIO_ENDPOINT ?? "");

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
				...(isHttps ? readTlsOptions(process.env) : {}),
			}),
		}),
	});

	return globalForS3.__projectoS3;
}
