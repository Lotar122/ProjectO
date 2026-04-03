"use server";

import { HeadBucketCommand, CreateBucketCommand } from "@aws-sdk/client-s3";

export async function createBucket(s3, bucketName) {
  try {
    // Check if exists
    await s3.send(new HeadBucketCommand({ Bucket: bucketName }));
    console.log(`Bucket "${bucketName}" already exists`);
    return false;
  } catch (err) {
    if (err.$metadata?.httpStatusCode !== 404) {
      throw err; // real error
    }
  }

  // Create if not exists
  await s3.send(new CreateBucketCommand({
    Bucket: bucketName,
  }));

  console.log(`Bucket "${bucketName}" created`);
  return true;
}