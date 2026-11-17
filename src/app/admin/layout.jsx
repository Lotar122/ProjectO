import AdminTopBar from "./components/AdminTopBar";
import { requireAdminSession } from "./requireAdminSession";
import { getIdentityName } from "../server-functions/getUserName";

export const metadata = {
	title: {
		template: "ProjectO - %s",
		default: "ProjectO - Administracja",
	},
};

export default async function AdminLayout({ children })
{
	const { data } = await requireAdminSession();
	const name = getIdentityName(data.identity);
	const userLabel = [name.first, name.last].filter(Boolean).join(" ") || data.identity.traits?.email || "Administrator";

	return (
		<div className="min-h-dvh text-foreground">
			<a
				href="#admin-content"
				className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-lg focus:bg-accent focus:px-4 focus:py-2 focus:font-semibold focus:text-accent-contrast">
				Przejdź do treści
			</a>
			<AdminTopBar userLabel={userLabel} />
			<main id="admin-content" tabIndex={-1} className="container mx-auto px-4 py-6 focus:outline-none sm:py-8">
				{children}
			</main>
		</div>
	);
}
