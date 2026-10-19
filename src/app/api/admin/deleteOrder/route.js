import { getUserAuthSession } from "@/app/server-functions/getUserAuthSession";
import { isAdminSession } from "@/app/server-functions/isAdminSession";
import { createS3Client } from "@/app/server-functions/MinIO/createS3Client";
import { deleteOrderFiles } from "@/app/server-functions/orders/orderFiles";
import { cookies } from "next/headers";
import { DB } from "@/app/lib/db";
import { internalError, jsonError } from "@/app/lib/apiErrors";
import { isUuid } from "@/app/lib/validate";
import { withRequestLogging } from "@/app/lib/withRequestLogging";
import { createLogger } from "@/app/lib/logger";

const log = createLogger("admin");

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

		const [order] = await DB`
			SELECT order_id, files
			FROM orders
			WHERE order_id = ${orderID}
			LIMIT 1
		`;

		if (!order)
		{
			return jsonError("Order not found", 404);
		}

		const s3 = await createS3Client();
		const undeletedFileIds = await deleteOrderFiles(s3, Array.isArray(order.files) ? order.files : []);

		// Keep the row while files remain, so the order can be deleted again instead of orphaning patient data.
		if (undeletedFileIds.length > 0)
		{
			log.error(`Order ${orderID} kept: ${undeletedFileIds.length} file(s) could not be deleted`);

			return internalError();
		}

		await DB`DELETE FROM orders WHERE order_id = ${orderID}`;

		log.info(`Order ${orderID} deleted by admin ${userAuthSession.data.identity.id}`);

		return Response.json({ success: true });
	}
	catch (err)
	{
		log.error("Failed to delete order", err);

		return internalError();
	}
}

export const DELETE = withRequestLogging(handleDelete);
