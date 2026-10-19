"use client";

import { m } from "framer-motion";
import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import { useCallback, useRef, useState } from "react";
import { UserPlus, Users } from "lucide-react";

import ManageUsers from "./ManageUsers";
import OrdersHeader from "../../orders/components/OrdersHeader";
import { KRATOS_PUBLIC } from "@/app/lib/kratos";

const IdentityCreationForm = dynamic(() => import("./IdentityCreationForm"));

export default function AdminDashboard()
{
	const router = useRouter();
	const [currentPage, setCurrentPage] = useState("manage-users");
	const [hasOpenedCreate, setHasOpenedCreate] = useState(false);
	const [refreshToken, setRefreshToken] = useState(0);
	const isLoggingOutRef = useRef(false);

	const showManageUsers = useCallback(() => setCurrentPage("manage-users"), []);

	const showCreateIdentity = useCallback(() =>
	{
		setHasOpenedCreate(true);
		setCurrentPage("create-identity");
	}, []);

	const showChangePassword = useCallback(() =>
	{
		router.push("/admin/orders?view=change-password");
	}, [router]);

	const handleCreated = useCallback(() => setRefreshToken((value) => value + 1), []);

	const handleLogout = useCallback(async () =>
	{
		if (isLoggingOutRef.current)
		{
			return;
		}

		isLoggingOutRef.current = true;

		try
		{
			const response = await fetch(`${KRATOS_PUBLIC}/self-service/logout/browser`, {
				credentials: "include",
				signal: AbortSignal.timeout(10000),
			});

			const data = await response.json();

			if (typeof data?.logout_url !== "string" || !data.logout_url)
			{
				console.error("Błąd wylogowania: brak logout_url", data);
				isLoggingOutRef.current = false;
				return;
			}

			// Keep the guard set: the page is navigating away.
			window.location.href = data.logout_url;
		}
		catch (error)
		{
			console.error("Błąd wylogowania:", error);
			isLoggingOutRef.current = false;
		}
	}, []);

	return (
		<m.div
			initial={{ opacity: 0 }}
			animate={{ opacity: 1 }}
			transition={{ duration: 0.45 }}
			className="min-h-dvh bg-transparent text-white">
			<OrdersHeader
				currentPage={currentPage}
				isAdmin
				isAdminPage
				onLogout={handleLogout}
				onShowChangePassword={showChangePassword}
				onShowCreateIdentity={showCreateIdentity}
				onShowManageUsers={showManageUsers}
			/>

			<main className="container mx-auto px-4 py-6 sm:py-8">
				<m.div
					initial={{ opacity: 0, y: 18 }}
					animate={{ opacity: 1, y: 0 }}
					className="mb-6 sm:mb-8">
					<div className="flex flex-col justify-between gap-5 sm:flex-row sm:items-end">
						<div>
							<p className="mb-2 text-xs font-semibold uppercase tracking-[0.18em] text-violet-300">
								Panel administratora
							</p>
							<h2 className="text-2xl font-bold text-white sm:text-3xl">Zarządzanie użytkownikami</h2>
							<p className="mt-2 text-slate-400">
								Wyświetlaj konta, edytuj ich dane i zarządzaj dostępem do systemu.
							</p>
						</div>
					</div>

					<div className="mt-6 flex flex-wrap gap-2 border-b border-slate-800 pb-4 sm:mt-8 sm:gap-3">
						<button
							type="button"
							onClick={showManageUsers}
							className={`flex min-h-10 items-center gap-2 rounded-xl px-4 py-2.5 text-sm font-semibold transition-colors ${currentPage === "manage-users" ? "bg-white text-slate-950" : "text-slate-300 hover:bg-slate-900 hover:text-white"}`}>
							<Users className="h-4 w-4" />
							Wszyscy użytkownicy
						</button>
						<button
							type="button"
							onClick={showCreateIdentity}
							className={`flex min-h-10 items-center gap-2 rounded-xl px-4 py-2.5 text-sm font-semibold transition-colors ${currentPage === "create-identity" ? "bg-violet-100 text-slate-950" : "text-slate-300 hover:bg-slate-900 hover:text-white"}`}>
							<UserPlus className="h-4 w-4" />
							Dodaj użytkownika
						</button>
					</div>
				</m.div>

				<div hidden={currentPage !== "manage-users"}>
					<ManageUsers refreshToken={refreshToken} />
				</div>

				{/* Stays mounted once opened so a half-filled form survives tab switches. */}
				{hasOpenedCreate && (
					<div hidden={currentPage !== "create-identity"}>
						<IdentityCreationForm onCancel={showManageUsers} onCreated={handleCreated} />
					</div>
				)}
			</main>
		</m.div>
	);
}
