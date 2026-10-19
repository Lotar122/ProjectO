import "server-only";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import Orders from "./orders";

import { getUserAuthSession } from "../server-functions/getUserAuthSession";
import { getIdentityName } from "../server-functions/getUserName";
import { isAdminSession } from "../server-functions/isAdminSession";
import { listOrders } from "../server-functions/orders/listOrders";
import { createLogger } from "../lib/logger";

const log = createLogger("orders");

export default async function ProtectedPage()
{
	const cookieHeader = await cookies();
	const userAuthSession = await getUserAuthSession(cookieHeader);

	if (userAuthSession.loggedIn)
	{
		const name = getIdentityName(userAuthSession.data.identity);
		let initialOrdersPayload = null;

		try
		{
			// First page rendered with the HTML; a failure here only means the client loads it itself.
			// The JSON round trip turns dates into the strings the API returns.
			initialOrdersPayload = JSON.parse(JSON.stringify(
				await listOrders({ userId: userAuthSession.data.identity.id }),
			));
		}
		catch (err)
		{
			log.warn(`Could not prefetch orders: ${err.message}`);
		}

		return (
			<Orders
				initialOrdersPayload={initialOrdersPayload}
				isAdmin={isAdminSession(userAuthSession)}
				userEmail={userAuthSession.data.identity.traits.email}
				userName={name.first}
				userLastName={name.last}
			/>
		);
	}

	redirect("/");
}
