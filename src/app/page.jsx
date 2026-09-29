import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { getUserAuthSession } from "./server-functions/getUserAuthSession";
import { isAdminSession } from "./server-functions/isAdminSession";

export default async function HomePage()
{
	const userAuthSession = await getUserAuthSession(await cookies());

	redirect(
		userAuthSession.loggedIn
			? isAdminSession(userAuthSession)
				? "/admin"
				: "/orders"
			: "/login",
	);
}

export const metadata = {
	title: "ProjectO",
	description: "System do zarządzania zamówieniami ortodontycznymi.",
};
