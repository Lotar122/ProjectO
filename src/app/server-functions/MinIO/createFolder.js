"use server";

async function createFolder(s3, bucket, folder)
{
	if (!(await folderExists(bucket, folder)))
	{
		await s3.send(
			new PutObjectCommand({
				Bucket: bucket,
				Key: folder.endsWith("/") ? folder : folder + "/",
				Body: "", // empty body
			}),
		);
		console.log(`Folder "${folder}" created`);
	}
	else
	{
		console.log(`Folder "${folder}" already exists`);
	}
}
