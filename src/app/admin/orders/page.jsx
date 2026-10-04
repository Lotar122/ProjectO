import AdminOrdersServerWrapper from "../adminOrdersServerWrapper";

export const metadata = {
	title: "ProjectO - Zlecenia administratora",
	description: "Przeglądaj i zarządzaj zleceniami wszystkich użytkowników.",
};

export default function AdminOrdersPage()
{
	return <AdminOrdersServerWrapper />;
}
