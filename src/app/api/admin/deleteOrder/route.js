import { getUserAuthSession } from "@/app/server-functions/getUserAuthSession";
import { isAdminSession } from "@/app/server-functions/isAdminSession";
import { createS3Client } from "@/app/server-functions/MinIO/createS3Client";
import { deleteOrderWithFiles } from "@/app/server-functions/orders/deleteOrderWithFiles";
import { cookies } from "next/headers";
import { internalError, jsonError, orderLockedError } from "@/app/lib/apiErrors";
import { isUuid } from "@/app/lib/validate";
import { withRequestLogging } from "@/app/lib/withRequestLogging";
import { createLogger } from "@/app/lib/logger";

const log = createLogger("admin");

const ORDER_DELETING_MESSAGE =
	"To zlecenie jest właśnie usuwane. Odśwież listę zleceń za chwilę.";

async function handleDelete(req)
{
	try
	{
		const userAuthSession = await getUserAuthSession(await cookies());

		if (!userAuthSession.loggedIn || !isAdminSession(userAuthSession))
		{
			return jsonError("Admin access required", 403);
		}

		const orderID = new URL(req.url).searchParams.get("orderID");

		if (!isUuid(orderID))
		{
			return jsonError("A valid orderID is required", 400);
		}

		const s3 = await createS3Client();
		// Admins may delete an order in any status, so there is no assertDeletable here.
		const outcome = await deleteOrderWithFiles({ s3, orderID, ownerId: null });

		switch (outcome.result)
		{
			case "not_found":
				return jsonError("Order not found", 404);

			case "deleting":
				log.warn(`Order ${orderID}: admin delete rejected, another delete is still running`);

				return orderLockedError(ORDER_DELETING_MESSAGE);

			case "files_left":
				// The row stays while files remain, so the order can be deleted again instead of orphaning patient data.
				log.error(`Order ${orderID} kept: ${outcome.undeletedFileIds.length} file(s) could not be deleted`);

				return internalError();

			case "ok":
				log.info(`Order ${orderID} deleted by admin ${userAuthSession.data.identity.id}`);

				return Response.json({ success: true });

			default:
				throw new Error(`Unexpected delete result: ${outcome?.result}`);
		}
	}
	catch (err)
	{
		log.error("Failed to delete order", err);

		return internalError();
	}
}

export const DELETE = withRequestLogging(handleDelete);
