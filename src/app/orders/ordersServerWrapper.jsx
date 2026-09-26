"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import Orders from "./orders";

import { getUserAuthSession } from "../server-functions/getUserAuthSession";
import { getNameFromEmail } from "../server-functions/getUserName";
import { isAdminSession } from "../server-functions/isAdminSession";

export default async function ProtectedPage()
{
	const cookieHeader = await cookies();
	const userAuthSession = await getUserAuthSession(cookieHeader);

	if (userAuthSession.loggedIn)
	{
		const name = await getNameFromEmail(
			userAuthSession.data.identity.traits.email,
		);
		return (
			<Orders
				isAdmin={isAdminSession(userAuthSession)}
				userEmail={userAuthSession.data.identity.traits.email}
				userName={name.first}
				userLastName={name.last}
			/>
		);
	}

	redirect("/");
}
