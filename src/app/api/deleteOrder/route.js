import { getUserAuthSession } from "@/app/server-functions/getUserAuthSession";
import { createS3Client } from "@/app/server-functions/MinIO/createS3Client";
import { deleteOrderWithFiles } from "@/app/server-functions/orders/deleteOrderWithFiles";

import { cookies } from "next/headers";

import { internalError, jsonError, orderLockedError } from "@/app/lib/apiErrors";
import { isOwnerEditableStatus, isUuid } from "@/app/lib/validate";
import { withRequestLogging } from "@/app/lib/withRequestLogging";
import { createLogger } from "@/app/lib/logger";

const log = createLogger("orders");

const ORDER_LOCKED_MESSAGE =
	"Tego zlecenia nie można już usunąć, ponieważ ma status Gotowe lub Zrealizowane.";

//Has to be used with credentials
async function handleDelete(req)
{
	try
	{
		const cookieHeader = await cookies();
		const userAuthSession = await getUserAuthSession(cookieHeader);

		if (!userAuthSession.loggedIn)
		{
			return jsonError("Forbidden", 403);
		}

		const url = new URL(req.url);
		const orderID = url.searchParams.get("orderID");

		if (!isUuid(orderID))
		{
			return jsonError("A valid orderID is required", 400);
		}

		const userID = userAuthSession.data.identity.id;
		const s3 = await createS3Client();
		const outcome = await deleteOrderWithFiles({
			s3,
			orderID,
			ownerId: userID,
			assertDeletable: (row) => isOwnerEditableStatus(row.status),
		});

		switch (outcome.result)
		{
			case "not_found":
				return jsonError("Order not found", 404);

			case "locked":
				log.warn(`Order ${orderID}: delete by ${userID} rejected, order is locked`);

				return orderLockedError(ORDER_LOCKED_MESSAGE);

			case "files_left":
				// The row stays while files remain, so the order can be deleted again instead of orphaning patient data.
				log.error(`Order ${orderID} kept: ${outcome.undeletedFileIds.length} file(s) could not be deleted`);

				return internalError();

			case "ok":
				log.info(`Order ${orderID} deleted by ${userID} (${outcome.fileCount} files)`);

				return Response.json({ success: true }, { status: 200 });

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
