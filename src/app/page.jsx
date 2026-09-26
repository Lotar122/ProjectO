import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { getUserAuthSession } from "./server-functions/getUserAuthSession";

export default async function HomePage()
{
	const userAuthSession = await getUserAuthSession(await cookies());

	redirect(userAuthSession.loggedIn ? "/orders" : "/login");
}

export const metadata = {
	title: "ProjectO",
	description: "System do zarządzania zamówieniami ortodontycznymi.",
};
