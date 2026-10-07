"use client";

import { motion } from "framer-motion";
import { LogOut, Package, Plus, Settings, ShieldCheck, UserCircle, UserPlus, Users } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";

const getDesktopNavItemClassName = (isActive) =>
	`flex items-center gap-2 whitespace-nowrap rounded-lg px-3 py-2 transition-colors ${isActive ? "bg-white text-black" : "text-gray-300 hover:text-white"}`;

const getMobileNavItemClassName = (isActive) =>
	`flex min-h-10 min-w-0 flex-1 flex-col items-center justify-center gap-1 rounded-lg px-2 py-2 text-xs font-medium transition-colors sm:flex-row sm:gap-2 sm:px-3 sm:text-sm ${isActive ? "bg-white text-slate-950" : "text-slate-300 hover:text-white"}`;

const mobileNavIconClassName = "h-4 w-4 shrink-0";
const mobileNavLabelClassName = "max-w-full truncate";

export default function OrdersHeader({
	currentPage,
	onLogout,
	onShowChangePassword,
	onShowCreateOrder,
	onShowCreateIdentity,
	onShowManageUsers,
	onShowOrders,
	isAdmin = false,
	isAdminPage = false,
	userLastName,
	userName,
})
{
	const [isSettingsOpen, setIsSettingsOpen] = useState(false);
	const settingsRef = useRef(null);
	const userLabel = isAdmin ? "Admin" : `Dr. ${userLastName || userName}`;

	useEffect(() =>
	{
		const handlePointerDown = (event) =>
		{
			if (!settingsRef.current?.contains(event.target)) setIsSettingsOpen(false);
		};
		document.addEventListener("pointerdown", handlePointerDown);
		return () => document.removeEventListener("pointerdown", handlePointerDown);
	}, []);

	const handleManageUsersClick = (event) =>
	{
		if (!onShowManageUsers)
		{
			return;
		}

		event.preventDefault();
		onShowManageUsers();
	};

	const adminDesktopNavigation = isAdminPage && (
		<>
			<Link
				href="/admin"
				onClick={handleManageUsersClick}
				className={getDesktopNavItemClassName(currentPage === "manage-users")}>
				<Users className="h-4 w-4" />
				Użytkownicy
			</Link>
			<Link
				href="/admin/orders"
				className={getDesktopNavItemClassName(currentPage === "orders")}>
				<ShieldCheck className="h-4 w-4" />
				Zlecenia administratora
			</Link>
		</>
	);
	const adminMobileNavigation = isAdminPage && (
		<>
			<Link
				href="/admin"
				onClick={handleManageUsersClick}
				className={getMobileNavItemClassName(currentPage === "manage-users")}>
				<Users className={mobileNavIconClassName} />
				<span className={mobileNavLabelClassName}>Użytkownicy</span>
			</Link>
			<Link
				href="/admin/orders"
				className={getMobileNavItemClassName(currentPage === "orders")}>
				<ShieldCheck className={mobileNavIconClassName} />
				<span className={mobileNavLabelClassName}>Zlecenia</span>
			</Link>
		</>
	);

	return (
		<>
			<motion.header
				initial={{ opacity: 0, y: -18 }}
				animate={{ opacity: 1, y: 0 }}
				transition={{ duration: 0.45 }}
				className="relative z-30 border-b border-slate-800 bg-slate-900/90 backdrop-blur-xl">
				<div className="container mx-auto px-4 py-4">
					<div className="flex items-center justify-between gap-3">
						<div className="flex min-w-0 items-center gap-3">
							<div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-white shadow-[0_12px_40px_rgba(255,255,255,0.12)] sm:h-10 sm:w-10">
								<Package className="h-5 w-5 text-black sm:h-6 sm:w-6" />
							</div>
							<h1 className="truncate text-xl font-bold text-white sm:text-2xl">ProjectO</h1>
						</div>
						<nav className="hidden items-center gap-2 lg:flex xl:gap-6">
							{!isAdminPage && (
								<button
									type="button"
									onClick={onShowOrders}
									className={getDesktopNavItemClassName(currentPage === "orders")}>
									<Package className="h-4 w-4" />
									Zlecenia
								</button>
							)}
							{!isAdminPage && (
								<button
									type="button"
									onClick={onShowCreateOrder}
									className={getDesktopNavItemClassName(currentPage === "create-order")}>
									<Plus className="h-4 w-4" />
									Nowe zlecenie
								</button>
							)}
							{adminDesktopNavigation}
							{isAdminPage && onShowCreateIdentity && (
								<button
									type="button"
									onClick={onShowCreateIdentity}
									className={getDesktopNavItemClassName(currentPage === "create-identity")}>
									<UserPlus className="h-4 w-4" />
									Nowy użytkownik
								</button>
							)}
						</nav>
						<div className="flex shrink-0 items-center gap-2 sm:gap-4">
							<div className="hidden items-center gap-2 text-sm text-gray-300 xl:flex">
								<UserCircle className="h-5 w-5" />
								{userLabel}
							</div>
							<div className="relative" ref={settingsRef}>
								<button
									type="button"
									onClick={() => setIsSettingsOpen((current) => !current)}
									className="flex h-10 w-10 items-center justify-center rounded-xl border border-slate-800 bg-slate-950/70 text-gray-300 transition-colors hover:border-slate-600 hover:text-white"
									aria-expanded={isSettingsOpen}
									aria-haspopup="menu"
									aria-label="Otwórz ustawienia">
									<Settings className="h-4 w-4" />
								</button>
								{isSettingsOpen && (
									<div className="absolute right-0 top-full z-20 mt-2 w-max min-w-52 max-w-[calc(100vw-5rem)] overflow-hidden rounded-2xl border border-slate-800 bg-slate-950 shadow-[0_20px_60px_rgba(0,0,0,0.45)] backdrop-blur-xl">
										<div className="flex items-center gap-3 border-b border-slate-800 px-4 py-3 text-sm text-slate-400 xl:hidden">
											<UserCircle className="h-4 w-4 shrink-0" />
											<span className="min-w-0 wrap-break-word">{userLabel}</span>
										</div>
										<button
											type="button"
											onClick={() =>
											{
												setIsSettingsOpen(false);
												onShowChangePassword();
											}}
											className="flex w-full items-center gap-3 px-4 py-3 text-left text-sm text-slate-200 transition-colors hover:bg-slate-900 hover:text-white"
											role="menuitem">
											<Settings className="h-4 w-4 shrink-0" />
											Zmień hasło
										</button>
									</div>
								)}
							</div>
							<button
								type="button"
								onClick={onLogout}
								className="flex h-10 min-w-10 items-center justify-center gap-2 whitespace-nowrap rounded-lg px-2.5 text-gray-300 transition-colors hover:text-white sm:px-4">
								<LogOut className="h-4 w-4 shrink-0" />
								<span className="sr-only sm:not-sr-only">Wyloguj się</span>
							</button>
						</div>
					</div>
				</div>
			</motion.header>
			<div className="border-b border-slate-800 bg-slate-900/90 backdrop-blur-xl lg:hidden">
				<div className="container mx-auto px-4 py-3">
					<div className="flex gap-2">
						{!isAdminPage && (
							<button
								type="button"
								onClick={onShowOrders}
								className={getMobileNavItemClassName(currentPage === "orders")}>
								<Package className={mobileNavIconClassName} />
								<span className={mobileNavLabelClassName}>Zlecenia</span>
							</button>
						)}
						{adminMobileNavigation}
						{isAdminPage && onShowCreateIdentity && (
							<button
								type="button"
								onClick={onShowCreateIdentity}
								aria-label="Nowy użytkownik"
								className={getMobileNavItemClassName(currentPage === "create-identity")}>
								<UserPlus className={mobileNavIconClassName} />
								<span className={mobileNavLabelClassName}>
									Nowy<span className="hidden sm:inline"> użytkownik</span>
								</span>
							</button>
						)}
						{!isAdminPage && (
							<button
								type="button"
								onClick={onShowCreateOrder}
								className={getMobileNavItemClassName(currentPage === "create-order")}>
								<Plus className={mobileNavIconClassName} />
								<span className={mobileNavLabelClassName}>Nowe</span>
							</button>
						)}
					</div>
				</div>
			</div>
		</>
	);
}
