"use server";

import { createBucket } from "@/app/server-functions/MinIO/createBucket";
import { DeleteObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { v7 as uuid7 } from "uuid";

export const ORDER_FILES_BUCKET = "projecto";

function escapeRegExp(value)
{
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function sanitizeOrderFileName(patient, originalFileName)
{
	const extensionIndex = originalFileName.lastIndexOf(".");
	const hasExtension = extensionIndex !== -1;
	const extension = hasExtension ? originalFileName.slice(extensionIndex) : "";
	let baseName = hasExtension ?
		originalFileName.slice(0, extensionIndex) :
		originalFileName;

	const patientParts = String(patient || "")
		.split(/\s+/)
		.map((part) => part.trim())
		.filter(Boolean)
		.sort((a, b) => b.length - a.length);

	for (const part of patientParts)
	{
		const escapedPart = escapeRegExp(part);
		baseName = baseName.replace(
			new RegExp(`(^|[\\s_-])${escapedPart}(?=$|[\\s_-])`, "gi"),
			"$1",
		);
	}

	baseName = baseName
		.replace(/[\s_-]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();

	const normalizedBaseName = baseName.toLowerCase();
	const normalizedExtension = extension.toLowerCase();

	if (normalizedExtension === ".stl")
	{
		if (/upper/.test(normalizedBaseName))
		{
			return "UpperJawScan.stl";
		}

		if (/lower/.test(normalizedBaseName))
		{
			return "LowerJawScan.stl";
		}
	}

	return baseName ? `${baseName}${extension}` : `file${extension}`;
}

export function toISODate(value)
{
	if (!value)
	{
		return null;
	}

	return new Date(value).toISOString().split("T")[0];
}

export async function ensureOrderFilesBucket(s3)
{
	await createBucket(s3, ORDER_FILES_BUCKET);
}

export async function uploadOrderFiles(s3, files, patient)
{
	return Promise.all(
		files.map(async (file) =>
		{
			const fileID = uuid7();
			const fileName = sanitizeOrderFileName(patient, file.name);
			const fileBuffer = Buffer.from(await file.arrayBuffer());

			await s3.send(
				new PutObjectCommand(
					{
						Bucket: ORDER_FILES_BUCKET,
						Key: fileID,
						Body: fileBuffer,
						Metadata:
					{
						original_name: fileName,
					},
					}),
			);

			return { fileID, fileName };
		}),
	);
}

export async function deleteOrderFiles(s3, fileIds)
{
	if (fileIds.length === 0)
	{
		return;
	}

	await Promise.all(
		fileIds.map((fileId) =>
			s3.send(
				new DeleteObjectCommand(
					{
						Bucket: ORDER_FILES_BUCKET,
						Key: fileId,
					}),
			),
		),
	);
}
