"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import Orders from "./orders";

import { getUserAuthSession } from "../server-functions/getUserAuthSession";
import { getNameFromEmail } from "../server-functions/getUserName";

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
				userEmail={userAuthSession.data.identity.traits.email}
				userName={name.first}
				userLastName={name.last}
			/>
		);
	}

	redirect("/");
}
