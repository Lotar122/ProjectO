import AdminOrdersServerWrapper from "../adminOrdersServerWrapper";

export const metadata = {
	title: "ProjectO - Zlecenia administratora",
	description: "Przeglądaj i zarządzaj zleceniami wszystkich użytkowników.",
};

export default async function AdminOrdersPage({ searchParams })
{
	const { view } = await searchParams;

	return <AdminOrdersServerWrapper initialView={view} />;
}
