import { getUserAuthSession } from "@/app/server-functions/getUserAuthSession";
import { isAdminSession } from "@/app/server-functions/isAdminSession";
import { cookies } from "next/headers";
import { internalError, orderLockedError } from "@/app/lib/apiErrors";
import { isUuid } from "@/app/lib/validate";
import { DB } from "@/app/lib/db";
import { DELETION_STALE_INTERVAL } from "@/app/server-functions/orders/orderRowLock";
import { withRequestLogging } from "@/app/lib/withRequestLogging";
import { createLogger } from "@/app/lib/logger";

const log = createLogger("admin");

const ORDER_DELETING_MESSAGE =
	"Nie można zmienić statusu tego zlecenia, ponieważ jest właśnie usuwane.";

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

		// An order whose deletion is running keeps its status until it is gone or
		// the deletion fails (deleteOrderWithFiles checked it may be deleted). A
		// marker older than DELETION_STALE_AFTER_MS (database clock) is a delete
		// that died and does not block.
		const [updatedOrder] = await DB`
			UPDATE orders
			SET status = ${status}::order_status,
				progress = ${STATUS_PROGRESS[status]}
			WHERE order_id = ${orderID}
				AND (orders.deleting_at IS NULL OR orders.deleting_at < now() - ${DELETION_STALE_INTERVAL}::interval)
			RETURNING order_id, status, progress
		`;

		if (!updatedOrder)
		{
			const [existing] = await DB`
				SELECT 1
				FROM orders
				WHERE order_id = ${orderID}
			`;

			if (existing)
			{
				log.warn(`Order ${orderID}: status change by admin ${userAuthSession.data.identity.id} rejected, the order is being deleted`);

				return orderLockedError(ORDER_DELETING_MESSAGE);
			}

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
