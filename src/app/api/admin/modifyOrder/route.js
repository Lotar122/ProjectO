import { getUserAuthSession } from "@/app/server-functions/getUserAuthSession";
import { isAdminSession } from "@/app/server-functions/isAdminSession";
import { createS3Client } from "@/app/server-functions/MinIO/createS3Client";
import { applyOrderEdit, readKnownFileIds } from "@/app/server-functions/orders/applyOrderEdit";
import {
	cleanUpOrderFiles,
	ensureOrderFilesBucket,
} from "@/app/server-functions/orders/orderFiles";
import {
	InvalidUploadError,
	UploadLimitError,
	receiveOrderUpload,
	uploadErrorResponse,
} from "@/app/server-functions/orders/multipartUpload";
import { cookies } from "next/headers";
import { fileBeingArchivedError, internalError, jsonError, orderLockedError } from "@/app/lib/apiErrors";
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

const ORDER_DELETING_MESSAGE =
	"Tego zlecenia nie można już edytować, ponieważ jest właśnie usuwane.";
const FILE_BEING_ARCHIVED_MESSAGE =
	"Nie można teraz zmienić nazwy pliku, ponieważ jest właśnie archiwizowany. Spróbuj ponownie za kilka minut.";

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

		// Admins may edit an order in any status, so there is no assertEditable here.
		const edit = await applyOrderEdit({
			s3,
			orderID,
			ownerId: null,
			patient: readText(fields.get("patient"), MAX_PATIENT_LENGTH),
			details: readText(fields.get("details") ?? "", MAX_DETAILS_LENGTH),
			dueDate: parseDateInput(fields.get("dueDate")),
			existingFileIds: fields.getAll("existingFileIds").filter(Boolean),
			knownFileIds: readKnownFileIds(fields.get("knownFileIds"), { log, orderID }),
			uploadedFileIds,
			uploadedBytes: files.reduce((sum, file) => sum + file.size, 0),
			fileNameUpdates: fields.getAll("fileNames").map(String),
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

			if (edit.result === "limit")
			{
				log.warn(`Order ${orderID}: admin update would exceed the per-order limit`);

				return uploadErrorResponse(new UploadLimitError(edit.message));
			}

			if (edit.result === "deleting")
			{
				log.warn(`Order ${orderID}: admin update rejected, the order is being deleted`);

				return orderLockedError(ORDER_DELETING_MESSAGE);
			}

			if (edit.result === "archiving")
			{
				log.warn(`Order ${orderID}: admin update rejected, renamed file(s) being archived: ${edit.fileIds.join(", ")}`);

				return fileBeingArchivedError(FILE_BEING_ARCHIVED_MESSAGE);
			}

			return jsonError("Order not found", 404);
		}

		// The order now points at the uploads; they must survive anything below.
		uploadedFileIds = [];

		log.info(`Order ${orderID} updated by admin ${userAuthSession.data.identity.id} (+${files.length} / -${edit.removedFileIds.length} files)`);

		return Response.json({ success: true, order: edit.order, uploadedFiles: files });
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
