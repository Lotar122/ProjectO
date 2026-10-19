import { getUserAuthSession } from "@/app/server-functions/getUserAuthSession";
import { isAdminSession } from "@/app/server-functions/isAdminSession";
import { createS3Client } from "@/app/server-functions/MinIO/createS3Client";
import {
	deleteOrderFiles,
	ensureOrderFilesBucket,
	renameRetainedFiles,
} from "@/app/server-functions/orders/orderFiles";
import {
	InvalidUploadError,
	receiveOrderUpload,
	uploadErrorResponse,
} from "@/app/server-functions/orders/multipartUpload";
import { cookies } from "next/headers";
import { DB } from "@/app/lib/db";
import { internalError, jsonError } from "@/app/lib/apiErrors";
import {
	MAX_DETAILS_LENGTH,
	MAX_PATIENT_LENGTH,
	isUuid,
	parseDateInput,
	readText,
} from "@/app/lib/validate";
import { withRequestLogging } from "@/app/lib/withRequestLogging";
import { createLogger } from "@/app/lib/logger";

const log = createLogger("admin");

// Rejects the request before any file is read when the text fields are bad.
function validateFields(fields)
{
	if (!isUuid(fields.get("orderID")))
	{
		throw new InvalidUploadError("A valid orderID is required");
	}

	if (!readText(fields.get("patient"), MAX_PATIENT_LENGTH))
	{
		throw new InvalidUploadError("A patient name is required");
	}

	if (readText(fields.get("details") ?? "", MAX_DETAILS_LENGTH) === undefined)
	{
		throw new InvalidUploadError("Details are too long");
	}

	if (parseDateInput(fields.get("dueDate")) === undefined)
	{
		throw new InvalidUploadError("Invalid due date");
	}
}

async function handlePut(req)
{
	let s3 = null;
	let uploadedFileIds = [];

	try 
	{
		const userAuthSession = await getUserAuthSession(await cookies());

		if (!userAuthSession.loggedIn || !isAdminSession(userAuthSession))
		{
			return jsonError("Admin access required", 403);
		}

		s3 = await createS3Client();
		await ensureOrderFilesBucket(s3);

		const { fields, files } = await receiveOrderUpload(req, s3, { validate: validateFields });

		uploadedFileIds = files.map((file) => file.fileID);

		const orderID = fields.get("orderID");
		const patient = readText(fields.get("patient"), MAX_PATIENT_LENGTH);
		const details = readText(fields.get("details") ?? "", MAX_DETAILS_LENGTH);
		const due_date = parseDateInput(fields.get("dueDate"));
		const existingFileIds = fields.getAll("existingFileIds").filter(Boolean);

		const [order] = await DB`
			SELECT order_id, files
			FROM orders
			WHERE order_id = ${orderID}
			LIMIT 1
		`;

		if (!order)
		{
			await deleteOrderFiles(s3, uploadedFileIds);

			return jsonError("Order not found", 404);
		}

		const currentFileIds = Array.isArray(order.files) ? order.files : [];
		const retainedFileIds = currentFileIds.filter((fileId) => existingFileIds.includes(fileId));
		const removedFileIds = currentFileIds.filter((fileId) => !retainedFileIds.includes(fileId));

		await renameRetainedFiles(s3, patient, retainedFileIds, fields.getAll("fileNames"));

		const nextFileIds = [...retainedFileIds, ...uploadedFileIds];

		const [updatedOrder] = await DB`
			UPDATE orders
			SET patient = ${patient},
				details = ${details},
				due_date = ${due_date},
				files = ${nextFileIds}
			WHERE order_id = ${orderID}
			RETURNING *
		`;

		// Removed files go last: if anything above failed, the order still points at files that exist.
		const undeletedFileIds = await deleteOrderFiles(s3, removedFileIds).catch((err) =>
		{
			log.error(`Could not delete removed files of order ${orderID}`, err);

			return removedFileIds;
		});

		if (undeletedFileIds.length > 0)
		{
			log.warn(`Order ${orderID}: ${undeletedFileIds.length} removed file(s) left in storage`);
		}

		log.info(`Order ${orderID} updated by admin ${userAuthSession.data.identity.id} (+${files.length} / -${removedFileIds.length} files)`);

		return Response.json({ success: true, order: updatedOrder, uploadedFiles: files });
	}
	catch (err) 
	{
		const uploadResponse = uploadErrorResponse(err);

		if (uploadResponse)
		{
			return uploadResponse;
		}

		log.error("Failed to update order", err);

		// The upload cleaned up after itself; files stored for an update that failed would be orphans.
		if (s3 && uploadedFileIds.length > 0)
		{
			await deleteOrderFiles(s3, uploadedFileIds).catch((cleanupErr) =>
			{
				log.error("Could not remove files of a failed update", cleanupErr);
			});
		}

		return internalError();
	}
}

export const PUT = withRequestLogging(handlePut);
