import { getUserAuthSession } from "@/app/server-functions/getUserAuthSession";
import { createS3Client } from "@/app/server-functions/MinIO/createS3Client";
import { applyOrderEdit, readKnownFileIds } from "@/app/server-functions/orders/applyOrderEdit";
import {
	cleanUpOrderFiles,
	ensureOrderFilesBucket,
} from "@/app/server-functions/orders/orderFiles";
import {
	InvalidUploadError,
	receiveOrderUpload,
	uploadErrorResponse,
} from "@/app/server-functions/orders/multipartUpload";
import { cookies } from "next/headers";
import { internalError, jsonError, orderLockedError } from "@/app/lib/apiErrors";
import {
	MAX_DETAILS_LENGTH,
	MAX_PATIENT_LENGTH,
	isOwnerEditableStatus,
	isUuid,
	parseDateInput,
	readText,
} from "@/app/lib/validate";
import { withRequestLogging } from "@/app/lib/withRequestLogging";
import { createLogger } from "@/app/lib/logger";

const log = createLogger("orders");

const ORDER_LOCKED_MESSAGE =
	"Tego zlecenia nie można już edytować, ponieważ ma status Gotowe lub Zrealizowane.";

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
	// Uploads of this request that no saved order points at yet; deleted on any failure.
	let uploadedFileIds = [];

	try
	{
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

		const orderID = fields.get("orderID");
		const userID = userAuthSession.data.identity.id;

		const edit = await applyOrderEdit({
			s3,
			orderID,
			ownerId: userID,
			patient: readText(fields.get("patient"), MAX_PATIENT_LENGTH),
			details: readText(fields.get("details") ?? "", MAX_DETAILS_LENGTH),
			dueDate: parseDateInput(fields.get("dueDate")),
			existingFileIds: fields.getAll("existingFileIds").filter(Boolean),
			knownFileIds: readKnownFileIds(fields.get("knownFileIds"), { log, orderID }),
			uploadedFileIds,
			fileNameUpdates: fields.getAll("fileNames").map(String),
			assertEditable: (row) => isOwnerEditableStatus(row.status),
			log,
		});

		if (edit.result !== "ok")
		{
			const pendingFileIds = uploadedFileIds;

			uploadedFileIds = [];
			await cleanUpOrderFiles(s3, pendingFileIds, {
				log,
				context: `a rejected update of order ${orderID}`,
			});

			if (edit.result === "locked")
			{
				log.warn(`Order ${orderID}: update by ${userID} rejected, order is locked`);

				return orderLockedError(ORDER_LOCKED_MESSAGE);
			}

			return jsonError("Order not found", 404);
		}

		// The order now points at the uploads; they must survive anything below.
		uploadedFileIds = [];

		log.info(`Order ${orderID} updated by ${userID} (+${files.length} / -${edit.removedFileIds.length} files)`);

		return Response.json({
			success: true,
			order: edit.order,
			uploadedFiles: files,
		});
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
			await cleanUpOrderFiles(s3, uploadedFileIds, {
				log,
				context: "a failed update",
			});
		}

		return internalError();
	}
}

export const PUT = withRequestLogging(handlePut);
