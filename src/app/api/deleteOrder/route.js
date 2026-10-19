import { getUserAuthSession } from "@/app/server-functions/getUserAuthSession";
import { createS3Client } from "@/app/server-functions/MinIO/createS3Client";
import { deleteOrderFiles } from "@/app/server-functions/orders/orderFiles";

import { cookies } from "next/headers";

import { DB } from "@/app/lib/db";
import { internalError, jsonError } from "@/app/lib/apiErrors";
import { isUuid } from "@/app/lib/validate";
import { withRequestLogging } from "@/app/lib/withRequestLogging";
import { createLogger } from "@/app/lib/logger";

const log = createLogger("orders");

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

		const [order] = await DB`
			SELECT order_id, files
			FROM orders
			WHERE order_id = ${orderID}
				AND user_id = ${userAuthSession.data.identity.id}
			LIMIT 1
		`;

		if (!order)
		{
			return jsonError("Order not found", 404);
		}

		const fileIds = Array.isArray(order.files) ? order.files : [];
		const s3 = await createS3Client();
		const undeletedFileIds = await deleteOrderFiles(s3, fileIds);

		// Keep the row while files remain, so the order can be deleted again instead of orphaning patient data.
		if (undeletedFileIds.length > 0)
		{
			log.error(`Order ${orderID} kept: ${undeletedFileIds.length} file(s) could not be deleted`);

			return internalError();
		}

		await DB`
			DELETE FROM orders
			WHERE order_id = ${orderID}
				AND user_id = ${userAuthSession.data.identity.id}
		`;

		log.info(`Order ${orderID} deleted by ${userAuthSession.data.identity.id} (${fileIds.length} files)`);

		return Response.json({ success: true }, { status: 200 });
	}
	catch (err)
	{
		log.error("Failed to delete order", err);

		return internalError();
	}
}

export const DELETE = withRequestLogging(handleDelete);
