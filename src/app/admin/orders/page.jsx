import { redirect } from "next/navigation";

import AdminOrdersServerWrapper from "../adminOrdersServerWrapper";

export const metadata = {
	title: "Zlecenia",
	description: "Przeglądaj i zarządzaj zleceniami wszystkich użytkowników.",
};

export default async function AdminOrdersPage({ searchParams })
{
	const { view } = await searchParams;

	// Old bookmarks: password change has its own admin route now.
	if (view === "change-password")
	{
		redirect("/admin/password?from=/admin/orders");
	}

	return <AdminOrdersServerWrapper />;
}
