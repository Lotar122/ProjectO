import AdminServerWrapper from "./adminServerWrapper";

export const metadata = {
	title: "ProjectO - Admin",
	description: "Manage all orthodontic appliance orders.",
};

export default function AdminPage()
{
	return <AdminServerWrapper />;
}
