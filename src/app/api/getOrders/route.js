import { getUserAuthSession } from "@/app/server-functions/getUserAuthSession";
import {
	InvalidOrderFilterError,
	listOrders,
} from "@/app/server-functions/orders/listOrders";
import { cookies } from "next/headers";
import { internalError, jsonError } from "@/app/lib/apiErrors";
import { withRequestLogging } from "@/app/lib/withRequestLogging";
import { createLogger } from "@/app/lib/logger";

const log = createLogger("orders");

async function handleGet(request)
{
	try 
	{
		const userAuthSession = await getUserAuthSession(await cookies());

		if (!userAuthSession.loggedIn)
		{
			return jsonError("Forbidden", 403);
		}

		const { searchParams } = new URL(request.url);
		const payload = await listOrders({
			userId: userAuthSession.data.identity.id,
			page: searchParams.get("page"),
			limit: searchParams.get("limit"),
			search: searchParams.get("search"),
			status: searchParams.get("status"),
		});

		return Response.json(payload);
	}
	catch (err) 
	{
		if (err instanceof InvalidOrderFilterError)
		{
			return jsonError(err.message, 400);
		}

		log.error("Failed to list orders", err);

		return internalError();
	}
}

export const GET = withRequestLogging(handleGet);
