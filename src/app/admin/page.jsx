import AdminServerWrapper from "./adminServerWrapper";

export const metadata = {
	title: "ProjectO - Administracja",
	description: "Zarządzaj wszystkimi zamówieniami ortodontycznymi.",
};

export default function AdminPage()
{
	return <AdminServerWrapper />;
}
