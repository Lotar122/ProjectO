"use server";

async function uploadFile(s3, bucket, folder, fileName, content) {
	await s3.send(
		new PutObjectCommand({
			Bucket: bucket,
			Key: `${folder.endsWith("/") ? folder : folder + "/"}${fileName}`,
			Body: content,
		}),
	);
	console.log(`File uploaded: ${folder}/${fileName}`);
}
