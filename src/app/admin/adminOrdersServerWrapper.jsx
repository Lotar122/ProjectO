import "server-only";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import Orders from "../orders/orders";
import { getUserAuthSession } from "../server-functions/getUserAuthSession";
import { isAdminSession } from "../server-functions/isAdminSession";
import { createLogger } from "../lib/logger";
import { getIdentityName } from "../server-functions/getUserName";

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

	return (
		<Orders
			adminMode
			isAdmin
			initialPage={initialView === "change-password" ? "change-password" : "orders"}
			userEmail={email}
			userName={name.first}
			userLastName={name.last}
		/>
	);
}
