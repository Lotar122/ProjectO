import "server-only";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import Orders from "../orders/orders";
import { getUserAuthSession } from "../server-functions/getUserAuthSession";
import { isAdminSession } from "../server-functions/isAdminSession";
import { createLogger } from "../lib/logger";
import { getIdentityName } from "../server-functions/getUserName";
import { listOrders } from "../server-functions/orders/listOrders";

const log = createLogger("admin");

export default async function AdminOrdersServerWrapper({ initialView })
{
	const userAuthSession = await getUserAuthSession(await cookies());

	if (!userAuthSession.loggedIn)
	{
		redirect("/");
	}

	if (!isAdminSession(userAuthSession))
	{
		log.warn(`Non-admin identity ${userAuthSession.data.identity.id} tried to open an admin page`);
		redirect("/orders");
	}

	const email = userAuthSession.data.identity.traits.email;
	const name = getIdentityName(userAuthSession.data.identity);

	let initialOrdersPayload = null;

	if (initialView !== "change-password")
	{
		try
		{
			// First page rendered with the HTML; a failure here only means the client loads it itself.
			// The JSON round trip turns dates into the strings the API returns.
			initialOrdersPayload = JSON.parse(JSON.stringify(await listOrders({})));
		}
		catch (err)
		{
			log.warn(`Could not prefetch orders: ${err.message}`);
		}
	}

	return (
		<Orders
			adminMode
			initialOrdersPayload={initialOrdersPayload}
			isAdmin
			initialPage={initialView === "change-password" ? "change-password" : "orders"}
			userEmail={email}
			userName={name.first}
			userLastName={name.last}
		/>
	);
}
