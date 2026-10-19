import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { getUserAuthSession } from "@/app/server-functions/getUserAuthSession";
import { isAdminSession } from "@/app/server-functions/isAdminSession";
import Login from "./login";

export default async function Page()
{
	let userAuthSession = null;

	try
	{
		userAuthSession = await getUserAuthSession(await cookies());
	}
	catch
	{
		// Kratos unreachable: show the form instead of redirecting back and forth.
	}

	if (userAuthSession?.loggedIn)
	{
		redirect(isAdminSession(userAuthSession) ? "/admin" : "/orders");
	}

	return <Login />;
}

export const metadata = {
	title: "ProjectO - Logowanie",
	description: "System do zarządzania zleceniami ortodontycznymi.",
};
