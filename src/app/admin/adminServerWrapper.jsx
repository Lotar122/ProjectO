"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import AdminDashboard from "./components/AdminDashboard";
import { getUserAuthSession } from "../server-functions/getUserAuthSession";
import { isAdminSession } from "../server-functions/isAdminSession";

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

	return <AdminDashboard />;
}
