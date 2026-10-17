import "server-only";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import Orders from "./orders";

import { getUserAuthSession } from "../server-functions/getUserAuthSession";
import { getIdentityName } from "../server-functions/getUserName";
import { isAdminSession } from "../server-functions/isAdminSession";

export default async function ProtectedPage()
{
	const cookieHeader = await cookies();
	const userAuthSession = await getUserAuthSession(cookieHeader);

	if (userAuthSession.loggedIn)
	{
		const name = getIdentityName(userAuthSession.data.identity);
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
