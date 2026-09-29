import AdminOrdersServerWrapper from "../adminOrdersServerWrapper";

export const metadata = {
	title: "ProjectO - Zamówienia administratora",
	description: "Przeglądaj i zarządzaj zamówieniami wszystkich użytkowników.",
};

export default function AdminOrdersPage()
{
	return <AdminOrdersServerWrapper />;
}
