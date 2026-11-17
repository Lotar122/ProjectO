import http from "@/app/lib/http";
import { KRATOS_PUBLIC } from "@/app/lib/kratos";

/**
 * Asks Kratos for a logout URL and navigates the browser to it.
 * Rejects when Kratos is unreachable or returns no URL; the page stays as it is.
 * @returns {Promise<void>}
 */
export async function redirectToLogout()
{
	const response = await http.get(`${KRATOS_PUBLIC}/self-service/logout/browser`, {
		withCredentials: true,
	});
	const logoutUrl = response.data?.logout_url;

	if (typeof logoutUrl !== "string" || !logoutUrl)
	{
		throw new Error("Kratos nie zwrócił adresu wylogowania.");
	}

	window.location.href = logoutUrl;
}
