"use client";

import { KeyRound, LogOut, Package, Plus, Settings, UserCircle } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";

const mobileNavItemClassName = "nav-link min-w-0 flex-1 flex-col justify-center gap-1 px-2 text-xs font-medium sm:flex-row sm:gap-2 sm:px-3 sm:text-sm";

const mobileNavIconClassName = "h-4 w-4 shrink-0";
const mobileNavLabelClassName = "max-w-full truncate";

export default function OrdersHeader({
	currentPage,
	onLogout,
	onShowChangePassword,
	onShowCreateOrder,
	onShowOrders,
	isAdmin = false,
	userLastName,
	userName,
})
{
	const [isSettingsOpen, setIsSettingsOpen] = useState(false);
	const settingsRef = useRef(null);
	const triggerRef = useRef(null);
		const menuId = useId();
	const displayName = userLastName || userName;
	const userLabel = isAdmin ? "Admin" : displayName ? `dr ${displayName}` : "Moje konto";

	useEffect(() =>
	{
		// Only listen while the menu is open; the page has no other document listener.
		if (!isSettingsOpen)
		{
			return;
		}

		const handlePointerDown = (event) =>
		{
			if (!settingsRef.current?.contains(event.target))
			{
				setIsSettingsOpen(false);
			}
		};

		const handleKeyDown = (event) =>
		{
			if (event.key === "Escape")
			{
				setIsSettingsOpen(false);
				triggerRef.current?.focus();
			}
		};

		document.addEventListener("pointerdown", handlePointerDown);
		document.addEventListener("keydown", handleKeyDown);

		return () =>
		{
			document.removeEventListener("pointerdown", handlePointerDown);
			document.removeEventListener("keydown", handleKeyDown);
		};
	}, [isSettingsOpen]);

	return (
		<>
			<header
				className="relative z-header border-b border-line bg-surface">
				<div className="container mx-auto px-4 py-4">
					<div className="flex items-center justify-between gap-3">
						<div className="flex min-w-0 items-center gap-3">
							<div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-accent text-accent-contrast sm:h-10 sm:w-10">
								<Package className="h-5 w-5 sm:h-6 sm:w-6" aria-hidden="true" />
							</div>
							<h1 className="truncate text-xl font-bold text-foreground sm:text-2xl">ProjectO</h1>
						</div>
						<nav aria-label="Główna nawigacja" className="hidden items-center gap-2 lg:flex xl:gap-6">
							<button
								type="button"
								onClick={onShowOrders}
								aria-current={currentPage === "orders" ? "page" : undefined}
								className="nav-link">
								<Package className="h-4 w-4" aria-hidden="true" />
								Zlecenia
							</button>
							<button
								type="button"
								onClick={onShowCreateOrder}
								aria-current={currentPage === "create-order" ? "page" : undefined}
								className="nav-link">
								<Plus className="h-4 w-4" aria-hidden="true" />
								Nowe zlecenie
							</button>
						</nav>
						<div className="flex shrink-0 items-center gap-2 sm:gap-4">
							<div className="hidden items-center gap-2 text-sm text-muted xl:flex">
								<UserCircle className="h-5 w-5" aria-hidden="true" />
								{userLabel}
							</div>
							<div className="relative" ref={settingsRef}>
								<button
									ref={triggerRef}
									type="button"
									onClick={() => setIsSettingsOpen((current) => !current)}
									className="btn btn-secondary w-11 px-0 aria-expanded:bg-surface-hover"
									aria-expanded={isSettingsOpen}
									aria-controls={menuId}
									aria-label="Ustawienia konta">
									<Settings className="h-4 w-4" aria-hidden="true" />
								</button>
								{isSettingsOpen && (
									<div
										id={menuId}
										className="menu absolute right-0 top-full z-dropdown mt-2 w-max min-w-52 max-w-[calc(100vw-5rem)]">
										<div className="flex items-center gap-3 border-b border-line px-4 py-3 text-sm text-muted xl:hidden">
											<UserCircle className="h-4 w-4 shrink-0" aria-hidden="true" />
											<span className="min-w-0 wrap-break-word">{userLabel}</span>
										</div>
										<button
											type="button"
											onClick={() =>
											{
												setIsSettingsOpen(false);
												onShowChangePassword();
											}}
											className="menu-item">
											<KeyRound className="h-4 w-4 shrink-0" aria-hidden="true" />
											Zmień hasło
										</button>
									</div>
								)}
							</div>
							<button
								type="button"
								onClick={onLogout}
								className="btn btn-ghost min-w-11 px-2.5 sm:px-4">
								<LogOut className="h-4 w-4 shrink-0" aria-hidden="true" />
								<span className="sr-only sm:not-sr-only">Wyloguj się</span>
							</button>
						</div>
					</div>
				</div>
			</header>
			<nav aria-label="Nawigacja mobilna" className="border-b border-line bg-surface lg:hidden">
				<div className="container mx-auto flex gap-2 px-4 py-3">
					<button
						type="button"
						onClick={onShowOrders}
						aria-current={currentPage === "orders" ? "page" : undefined}
						className={mobileNavItemClassName}>
						<Package className={mobileNavIconClassName} aria-hidden="true" />
						<span className={mobileNavLabelClassName}>Zlecenia</span>
					</button>
					<button
						type="button"
						onClick={onShowCreateOrder}
						aria-current={currentPage === "create-order" ? "page" : undefined}
						className={mobileNavItemClassName}>
						<Plus className={mobileNavIconClassName} aria-hidden="true" />
						<span className={mobileNavLabelClassName}>Nowe zlecenie</span>
					</button>
				</div>
			</nav>
		</>
	);
}
