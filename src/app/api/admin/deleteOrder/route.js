import { getUserAuthSession } from "@/app/server-functions/getUserAuthSession";
import { isAdminSession } from "@/app/server-functions/isAdminSession";
import { createS3Client } from "@/app/server-functions/MinIO/createS3Client";
import { deleteOrderFiles } from "@/app/server-functions/orders/orderFiles";
import { cookies } from "next/headers";
import { DB } from "@/app/lib/db";
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
			return Response.json({ error: "Admin access required" }, { status: 403 });
		}

		const orderID = new URL(req.url).searchParams.get("orderID");

		if (!orderID)
		{
			return Response.json({ error: "orderID is required" }, { status: 400 });
		}

		const [order] = await DB`
			SELECT order_id, files
			FROM orders
			WHERE order_id = ${orderID}
			LIMIT 1
		`;

		if (!order)
		{
			return Response.json({ error: "Order not found" }, { status: 404 });
		}

		const s3 = await createS3Client();
		await deleteOrderFiles(s3, Array.isArray(order.files) ? order.files : []);
		await DB`DELETE FROM orders WHERE order_id = ${orderID}`;

		log.info(`Order ${orderID} deleted by admin ${userAuthSession.data.identity.id}`);

		return Response.json({ success: true });
	}
	catch (err)
	{
		log.error("Failed to delete order", err);

		return Response.json(
			{ success: false, error: err.message },
			{ status: 500 },
		);
	}
}

export const DELETE = withRequestLogging(handleDelete);
