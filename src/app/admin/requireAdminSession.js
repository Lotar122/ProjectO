import "server-only";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";

import { getUserAuthSession } from "../server-functions/getUserAuthSession";
import { isAdminSession } from "../server-functions/isAdminSession";
import { createLogger } from "../lib/logger";

const log = createLogger("admin");

/**
 * The one admin guard. Redirects logged-out visitors to "/" and non-admins to
 * "/orders", otherwise returns the session. Cached per request, so the layout
 * and a page that needs the identity share a single Kratos round trip.
 * @returns {Promise<{ loggedIn: true, data: object }>}
 */
export const requireAdminSession = cache(async () =>
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

	return userAuthSession;
});
