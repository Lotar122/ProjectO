import "server-only";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import AdminDashboard from "./components/AdminDashboard";
import { getUserAuthSession } from "../server-functions/getUserAuthSession";
import { isAdminSession } from "../server-functions/isAdminSession";
import { createLogger } from "../lib/logger";

const log = createLogger("admin");

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
		log.warn(`Non-admin identity ${userAuthSession.data.identity.id} tried to open an admin page`);
		redirect("/orders");
	}

	return <AdminDashboard />;
}
