import "server-only";

import { mapWithConcurrency } from "@/app/lib/concurrency";
import { createBucket } from "@/app/server-functions/MinIO/createBucket";
import { encodeMetadataValue } from "@/app/server-functions/MinIO/metadataEncoding";
import {
	CopyObjectCommand,
	DeleteObjectsCommand,
	HeadObjectCommand,
} from "@aws-sdk/client-s3";

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

// Checked once per process instead of a HeadBucket on every upload.
// Reset on failure so the next request retries.
let orderFilesBucketReady = null;

export async function ensureOrderFilesBucket(s3)
{
	orderFilesBucketReady ??= createBucket(s3, ORDER_FILES_BUCKET).catch((err) =>
	{
		orderFilesBucketReady = null;
		throw err;
	});

	await orderFilesBucketReady;
}

// S3 DeleteObjects takes at most 1000 keys per call.
const DELETE_BATCH_SIZE = 1000;

// Resolves to the ids that could not be deleted (empty when everything went through).
export async function deleteOrderFiles(s3, fileIds)
{
	const failedIds = [];

	for (let offset = 0; offset < fileIds.length; offset += DELETE_BATCH_SIZE)
	{
		const batch = fileIds.slice(offset, offset + DELETE_BATCH_SIZE);
		const result = await s3.send(
			new DeleteObjectsCommand({
				Bucket: ORDER_FILES_BUCKET,
				Delete: {
					Objects: batch.map((fileId) => ({ Key: fileId })),
					Quiet: true,
				},
			}),
		);

		failedIds.push(...(result.Errors ?? []).map((error) => error.Key));
	}

	return failedIds;
}

const METADATA_UPDATE_ATTEMPTS = 3;

// True for a failed S3 precondition (If-Match / x-amz-copy-source-if-match).
export function isPreconditionFailed(err)
{
	return err?.name === "PreconditionFailed" || err?.$metadata?.httpStatusCode === 412;
}

// buildUpdate receives the current metadata and returns the keys to change,
// or null to leave the object untouched (no copy needed).
//
// The copy only goes through while the object still has the ETag that was read
// (CopySourceIfMatch). Otherwise the archiver could replace the bytes between
// the HEAD and the copy, and the copy would put the stale metadata (without
// `compression`) on compressed bytes. On a precondition failure the metadata
// is read again and buildUpdate re-run on it. A metadata-only copy keeps the
// content ETag, so this guards against content replacements, not against two
// concurrent metadata updates.
export async function updateOrderFileMetadata(s3, fileId, buildUpdate)
{
	for (let attempt = 1; ; attempt++)
	{
		const head = await s3.send(
			new HeadObjectCommand({
				Bucket: ORDER_FILES_BUCKET,
				Key: fileId,
			}),
		);
		const metadataUpdate = buildUpdate(head.Metadata ?? {});

		if (!metadataUpdate)
		{
			return false;
		}

		try
		{
			await s3.send(
				new CopyObjectCommand({
					Bucket: ORDER_FILES_BUCKET,
					Key: fileId,
					CopySource: `${ORDER_FILES_BUCKET}/${encodeURIComponent(fileId)}`,
					...(head.ETag ? { CopySourceIfMatch: head.ETag } : {}),
					ContentType: head.ContentType,
					ChecksumAlgorithm: "SHA256",
					Metadata: {
						...head.Metadata,
						...metadataUpdate,
					},
					MetadataDirective: "REPLACE",
				}),
			);

			return true;
		}
		catch (err)
		{
			if (!isPreconditionFailed(err) || attempt >= METADATA_UPDATE_ATTEMPTS)
			{
				throw err;
			}
		}
	}
}

// Returns false when the file already has that name, so unchanged attachments
// are not rewritten in S3 on every save.
export async function renameOrderFile(s3, fileId, fileName)
{
	const encodedName = encodeMetadataValue(fileName);

	return updateOrderFileMetadata(s3, fileId, (metadata) =>
		metadata.original_name === encodedName ? null : { original_name: encodedName });
}

export async function setOrderFileChecksum(s3, fileId, sha256)
{
	return updateOrderFileMetadata(s3, fileId, (metadata) =>
		metadata.sha256 === sha256 ? null : { sha256 });
}

const RENAME_CONCURRENCY = 4;

// requestedFileNames are the JSON-encoded { fileId, fileName } entries of the
// edit form. Only files that stay on the order are renamed.
export async function renameRetainedFiles(s3, patient, retainedFileIds, requestedFileNames)
{
	const updates = [];

	for (const value of requestedFileNames)
	{
		let fileNameUpdate;

		try
		{
			fileNameUpdate = JSON.parse(String(value));
		}
		catch
		{
			continue;
		}

		const fileId = String(fileNameUpdate?.fileId);
		const fileName = String(fileNameUpdate?.fileName || "").trim();

		if (retainedFileIds.includes(fileId) && fileName)
		{
			updates.push({ fileId, fileName: sanitizeOrderFileName(patient, fileName) });
		}
	}

	await mapWithConcurrency(updates, RENAME_CONCURRENCY, ({ fileId, fileName }) =>
		renameOrderFile(s3, fileId, fileName));
}
