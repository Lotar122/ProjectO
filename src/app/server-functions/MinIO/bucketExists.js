"use server";

export async function bucketExists(s3, bucketName) {
	try {
		await s3.send(new HeadBucketCommand({ Bucket: bucketName }));
		return true;
	} catch (err) {
		if (err.name === "NotFound" || err.$metadata?.httpStatusCode === 404) {
			return false;
		}
		throw err; // rethrow unexpected errors
	}
}
