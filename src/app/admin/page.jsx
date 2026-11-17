import { Suspense } from "react";

import UsersPage from "./components/UsersPage";

export const metadata = {
	title: "Użytkownicy",
	description: "Zarządzaj kontami użytkowników systemu.",
};

export default function AdminUsersPage()
{
	// UsersPage reads ?view= on the client; the boundary keeps the rest of the route renderable.
	return (
		<Suspense>
			<UsersPage />
		</Suspense>
	);
}
