"use client";

import { MotionConfig, motion } from "framer-motion";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { UserPlus, Users } from "lucide-react";

import IdentityCreationForm from "./IdentityCreationForm";
import ManageUsers from "./ManageUsers";
import OrdersHeader from "../../orders/components/OrdersHeader";
import PerfProfiler from "@/app/components/perf/PerfProfiler";
import { getPerfFlags } from "@/app/components/perf/perfFlags";
import { KRATOS_PUBLIC } from "@/app/lib/kratos";

export default function AdminDashboard()
{
	const { disableMotion } = getPerfFlags();
	const router = useRouter();
	const [currentPage, setCurrentPage] = useState("manage-users");
	const [refreshToken, setRefreshToken] = useState(0);

	const handleLogout = async () =>
	{
		try
		{
			const response = await fetch(`${KRATOS_PUBLIC}/self-service/logout/browser`, {
				credentials: "include",
			});

			const data = await response.json();
			window.location.href = data.logout_url;
		}
		catch (error)
		{
			console.error("Błąd wylogowania:", error);
		}
	};

	return (
		<MotionConfig reducedMotion={disableMotion ? "always" : "never"}>
			<PerfProfiler id="AdminDashboard">
				<motion.div
					initial={{ opacity: 0 }}
					animate={{ opacity: 1 }}
					transition={{ duration: disableMotion ? 0 : 0.45 }}
					className="min-h-dvh bg-transparent text-white">
					<OrdersHeader
						currentPage={currentPage}
						isAdmin
						isAdminPage
						onLogout={handleLogout}
						onShowChangePassword={() =>
						{
							router.push("/admin/orders?view=change-password");
						}}
						onShowCreateIdentity={() => setCurrentPage("create-identity")}
						onShowManageUsers={() => setCurrentPage("manage-users")}
					/>

					<main className="container mx-auto px-4 py-6 sm:py-8">
						<motion.div
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
									onClick={() => setCurrentPage("manage-users")}
									className={`flex min-h-10 items-center gap-2 rounded-xl px-4 py-2.5 text-sm font-semibold transition-colors ${currentPage === "manage-users" ? "bg-white text-slate-950" : "text-slate-300 hover:bg-slate-900 hover:text-white"}`}>
									<Users className="h-4 w-4" />
									Wszyscy użytkownicy
								</button>
								<button
									type="button"
									onClick={() => setCurrentPage("create-identity")}
									className={`flex min-h-10 items-center gap-2 rounded-xl px-4 py-2.5 text-sm font-semibold transition-colors ${currentPage === "create-identity" ? "bg-violet-100 text-slate-950" : "text-slate-300 hover:bg-slate-900 hover:text-white"}`}>
									<UserPlus className="h-4 w-4" />
									Dodaj użytkownika
								</button>
							</div>
						</motion.div>

						<div hidden={currentPage !== "manage-users"}>
							<ManageUsers refreshToken={refreshToken} />
						</div>

						<div hidden={currentPage !== "create-identity"}>
							<IdentityCreationForm
								onCancel={() => setCurrentPage("manage-users")}
								onCreated={() => setRefreshToken((value) => value + 1)}
							/>
						</div>
					</main>

				</motion.div>
			</PerfProfiler>
		</MotionConfig>
	);
}
