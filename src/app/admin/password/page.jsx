import ChangePasswordPage from "../components/ChangePasswordPage";
import { getAdminReturnPath } from "../adminNav";
import { requireAdminSession } from "../requireAdminSession";

export const metadata = {
	title: "Zmień hasło",
	description: "Zmień hasło do swojego konta administratora.",
};

export default async function AdminPasswordPage({ searchParams })
{
	const [{ from }, { data }] = await Promise.all([searchParams, requireAdminSession()]);

	return (
		<ChangePasswordPage
			returnPath={getAdminReturnPath(from)}
			userEmail={data.identity.traits.email}
		/>
	);
}
