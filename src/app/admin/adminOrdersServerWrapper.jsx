import "server-only";

import Orders from "../orders/orders";
import { requireAdminSession } from "./requireAdminSession";
import { createLogger } from "../lib/logger";
import { listOrders } from "../server-functions/orders/listOrders";

const log = createLogger("admin");

export default async function AdminOrdersServerWrapper()
{
	// Same cached check the layout runs; awaited here so orders are only listed for an admin.
	const { data } = await requireAdminSession();
	let initialOrdersPayload = null;

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

	return (
		<Orders
			adminMode
			initialOrdersPayload={initialOrdersPayload}
			isAdmin
			userEmail={data.identity.traits.email}
		/>
	);
}
