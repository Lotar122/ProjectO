import { getUserAuthSession } from "@/app/server-functions/getUserAuthSession";
import { isAdminSession } from "@/app/server-functions/isAdminSession";
import { cookies } from "next/headers";
import { internalError } from "@/app/lib/apiErrors";
import { isUuid } from "@/app/lib/validate";
import { DB } from "@/app/lib/db";
import { withRequestLogging } from "@/app/lib/withRequestLogging";
import { createLogger } from "@/app/lib/logger";

const log = createLogger("admin");

const STATUS_PROGRESS = {
	pending: 0,
	"in-progress": 50,
	shipped: 75,
	completed: 100,
};

async function handlePut(req)
{
	try 
	{
		const userAuthSession = await getUserAuthSession(await cookies());

		if (!userAuthSession.loggedIn || !isAdminSession(userAuthSession))
		{
			return Response.json({ error: "Admin access required" }, { status: 403 });
		}

		let payload;

		try
		{
			payload = await req.json();
		}
		catch
		{
			return Response.json({ error: "Invalid JSON body" }, { status: 400 });
		}

		const { orderID, status } = payload ?? {};

		if (!isUuid(orderID) || !Object.hasOwn(STATUS_PROGRESS, status))
		{
			return Response.json(
				{ error: "A valid orderID and status are required" },
				{ status: 400 },
			);
		}

		const [updatedOrder] = await DB`
			UPDATE orders
			SET status = ${status}::order_status,
				progress = ${STATUS_PROGRESS[status]}
			WHERE order_id = ${orderID}
			RETURNING *
		`;

		if (!updatedOrder)
		{
			return Response.json({ error: "Order not found" }, { status: 404 });
		}

		log.info(`Order ${orderID} status set to ${status} by admin ${userAuthSession.data.identity.id}`);

		return Response.json({ success: true, order: updatedOrder });
	}
	catch (err)
	{
		log.error("Failed to update order status", err);

		return internalError();
	}
}

export const PUT = withRequestLogging(handlePut);
