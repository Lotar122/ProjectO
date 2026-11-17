import { Archive, Package, Users } from "lucide-react";

export const ADMIN_HOME_PATH = "/admin";
export const ADMIN_PASSWORD_PATH = "/admin/password";

/** Top bar items, in display order. Every admin page shows the same list. */
export const ADMIN_NAV_ITEMS = [
	{ href: ADMIN_HOME_PATH, label: "Użytkownicy", icon: Users },
	{ href: "/admin/orders", label: "Zlecenia", icon: Package },
	{ href: "/admin/archiver", label: "Archiwizacja", icon: Archive },
];

/**
 * @param {string} pathname
 * @param {string} href
 * @returns {boolean} Whether the nav item at `href` is the current page.
 */
export function isActiveAdminPath(pathname, href)
{
	if (href === ADMIN_HOME_PATH)
	{
		return pathname === href;
	}

	return pathname === href || pathname.startsWith(`${href}/`);
}

/**
 * Picks where the password page returns to. Only admin nav pages are allowed,
 * so the query string cannot send the user off the site.
 * @param {string | null | undefined} from
 * @returns {string}
 */
export function getAdminReturnPath(from)
{
	return ADMIN_NAV_ITEMS.some(({ href }) => href === from) ? from : ADMIN_HOME_PATH;
}
