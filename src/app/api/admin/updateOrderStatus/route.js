"use server";

import { getUserAuthSession } from "@/app/server-functions/getUserAuthSession";
import { isAdminSession } from "@/app/server-functions/isAdminSession";
import { cookies } from "next/headers";
import postgres from "postgres";

const STATUS_PROGRESS = {
	pending: 0,
	"in-progress": 50,
	shipped: 75,
	completed: 100,
};

export async function PUT(req)
{
	let DB = null;

	try 
	{
		const userAuthSession = await getUserAuthSession(await cookies());

		if (!userAuthSession.loggedIn || !isAdminSession(userAuthSession))
		{
			return Response.json({ error: "Admin access required" }, { status: 403 });
		}

		const { orderID, status } = await req.json();

		if (!orderID || !Object.hasOwn(STATUS_PROGRESS, status))
		{
			return Response.json(
				{ error: "A valid orderID and status are required" },
				{ status: 400 },
			);
		}

		DB = postgres(process.env.DB_URL, { prepare: true, /*ssl: "require"*/ });

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

		return Response.json({ success: true, order: updatedOrder });
	}
	catch (err) 
	{
		return Response.json(
			{ success: false, error: err.message },
			{ status: 500 },
		);
	}
	finally 
	{
		await DB?.end();
	}
}
