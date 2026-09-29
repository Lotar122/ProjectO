import AdminServerWrapper from "./adminServerWrapper";

export const metadata = {
	title: "ProjectO - Administracja",
	description: "Zarządzaj użytkownikami i kontami systemu.",
};

export default function AdminPage()
{
	return <AdminServerWrapper />;
}
