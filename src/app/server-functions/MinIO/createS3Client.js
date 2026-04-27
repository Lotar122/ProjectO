import { S3Client } from "@aws-sdk/client-s3";
import { NodeHttpHandler } from "@aws-sdk/node-http-handler";
import https from "https";

export async function createS3Client() {
    return new S3Client({
        endpoint: process.env.MINIO_ENDPOINT,
        region: 'us-east-1',
        credentials: {
            accessKeyId: process.env.MINIO_ACCESS_KEY,
            secretAccessKey: process.env.MINIO_SECRET_KEY,
        },
        forcePathStyle: true,
        requestHandler: new NodeHttpHandler({
            httpsAgent: new https.Agent({
                rejectUnauthorized: false
            })
        })
    });
}
