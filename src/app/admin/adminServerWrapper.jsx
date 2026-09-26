"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import Orders from "../orders/orders";
import { getUserAuthSession } from "../server-functions/getUserAuthSession";
import { isAdminSession } from "../server-functions/isAdminSession";
import { getNameFromEmail } from "../server-functions/getUserName";

export default async function AdminServerWrapper()
{
	const cookieStore = await cookies();
	const userAuthSession = await getUserAuthSession(cookieStore);

	if (!userAuthSession.loggedIn)
	{
		redirect("/");
	}

	if (!isAdminSession(userAuthSession))
	{
		redirect("/orders");
	}

	const email = userAuthSession.data.identity.traits.email;
	const name = await getNameFromEmail(email);

	return (
		<Orders
			adminMode
			isAdmin
			userEmail={email}
			userName={name.first}
			userLastName={name.last}
		/>
	);
}
