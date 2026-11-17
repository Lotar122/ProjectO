"use client";

import dynamic from "next/dynamic";
import { useSearchParams } from "next/navigation";
import { useCallback, useState } from "react";
import { UserPlus } from "lucide-react";

import Alert from "@/app/components/Alert";
import AdminPageHeader from "./AdminPageHeader";
import ManageUsers from "./ManageUsers";
import { ADMIN_HOME_PATH } from "../adminNav";

const IdentityCreationForm = dynamic(() => import("./IdentityCreationForm"));

export const NEW_USER_VIEW = "new-user";

// Next.js syncs native history calls with useSearchParams, so switching views
// needs no server round trip and the back button still works.
const navigateTo = (url) =>
{
	window.history.pushState(null, "", url);
};

export default function UsersPage()
{
	const searchParams = useSearchParams();
	const isCreating = searchParams.get("view") === NEW_USER_VIEW;
	const [refreshToken, setRefreshToken] = useState(0);
	const [createdNotice, setCreatedNotice] = useState("");

	const openCreate = useCallback(() =>
	{
		setCreatedNotice("");
		navigateTo(`${ADMIN_HOME_PATH}?view=${NEW_USER_VIEW}`);
	}, []);

	const closeCreate = useCallback(() =>
	{
		navigateTo(ADMIN_HOME_PATH);
	}, []);

	const handleCreated = useCallback(() =>
	{
		setRefreshToken((value) => value + 1);
		setCreatedNotice("Konto zostało utworzone. Użytkownik może się teraz zalogować.");
		navigateTo(ADMIN_HOME_PATH);
	}, []);

	if (isCreating)
	{
		return (
			<>
				<AdminPageHeader
					title="Nowy użytkownik"
					description="Utwórz konto i nadaj mu rolę. Po zapisaniu wrócisz do listy użytkowników."
				/>
				<IdentityCreationForm onCancel={closeCreate} onCreated={handleCreated} />
			</>
		);
	}

	return (
		<>
			<AdminPageHeader
				title="Użytkownicy"
				description="Wyświetlaj konta, edytuj ich dane i zarządzaj dostępem do systemu."
				action={(
					<button
						type="button"
						onClick={openCreate}
						className="btn btn-primary w-full px-6 sm:w-auto">
						<UserPlus className="h-5 w-5" aria-hidden="true" />
						Nowy użytkownik
					</button>
				)}
			/>

			<div aria-live="polite">
				{createdNotice && (
					<Alert tone="success" announce={false} className="mb-5">{createdNotice}</Alert>
				)}
			</div>

			<ManageUsers refreshToken={refreshToken} />
		</>
	);
}
