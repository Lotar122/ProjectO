import { getUserAuthSession } from "@/app/server-functions/getUserAuthSession";
import { createS3Client } from "@/app/server-functions/MinIO/createS3Client";
import {
	deleteOrderFiles,
	ensureOrderFilesBucket,
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
	parseDateInput,
	readText,
} from "@/app/lib/validate";
import { v7 as uuid7 } from "uuid";
import { withRequestLogging } from "@/app/lib/withRequestLogging";
import { createLogger } from "@/app/lib/logger";

const log = createLogger("orders");

// Rejects the request before any file is read when the text fields are bad.
function validateFields(fields)
{
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

// Server POST function for inserting orders
async function handlePost(req)
{
	let s3 = null;
	let uploadedFileIds = [];

	try
	{
		// Get user session before reading the body, so anonymous requests
		// don't make the server buffer whole uploads
		const cookieHeader = await cookies();
		const userAuthSession = await getUserAuthSession(cookieHeader);

		if (!userAuthSession.loggedIn)
		{
			return jsonError("Forbidden", 403);
		}

		s3 = await createS3Client();
		await ensureOrderFilesBucket(s3);

		const { fields, files } = await receiveOrderUpload(req, s3, { validate: validateFields });

		uploadedFileIds = files.map((file) => file.fileID);

		const orderID = uuid7();
		const userID = userAuthSession.data.identity.id;
		const patient = readText(fields.get("patient"), MAX_PATIENT_LENGTH);
		const details = readText(fields.get("details") ?? "", MAX_DETAILS_LENGTH);
		const due_date = parseDateInput(fields.get("dueDate"));

		// Status, progress and issue date are set here, never taken from the
		// client: they are the admin's to change (see admin/updateOrderStatus).
		await DB`
			INSERT INTO orders (
				order_id, user_id, patient, details, status, progress, issue_date, due_date, files
			) VALUES (
				${orderID}, ${userID}, ${patient}, ${details}, 'pending'::order_status, 0, CURRENT_DATE, ${due_date}, ${uploadedFileIds}
			)
		`;

		log.info(`Order ${orderID} created by ${userID} (${uploadedFileIds.length} files)`);

		return Response.json({ success: true, orderID });
	}
	catch (err)
	{
		const uploadResponse = uploadErrorResponse(err);

		if (uploadResponse)
		{
			return uploadResponse;
		}

		log.error("Failed to create order", err);

		// The upload cleaned up after itself; files stored for an order whose insert failed would be orphans.
		if (s3 && uploadedFileIds.length > 0)
		{
			await deleteOrderFiles(s3, uploadedFileIds).catch((cleanupErr) =>
			{
				log.error("Could not remove files of a failed order", cleanupErr);
			});
		}

		return internalError();
	}
}

export const POST = withRequestLogging(handlePost);
