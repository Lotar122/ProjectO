"use client";

import { KeyRound, LogOut, Package, Settings, UserCircle } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useId, useRef, useState } from "react";

import { redirectToLogout } from "@/app/lib/logout";
import {
	ADMIN_HOME_PATH,
	ADMIN_NAV_ITEMS,
	ADMIN_PASSWORD_PATH,
	isActiveAdminPath,
} from "../adminNav";

const MOBILE_NAV_ITEM_CLASS = "nav-link min-w-0 flex-1 flex-col justify-center gap-1 px-2 text-xs font-medium sm:flex-row sm:gap-2 sm:px-3 sm:text-sm";

export default function AdminTopBar({ userLabel })
{
	const pathname = usePathname();
	const [isSettingsOpen, setIsSettingsOpen] = useState(false);
	const [logoutError, setLogoutError] = useState("");
	const settingsRef = useRef(null);
	const settingsButtonRef = useRef(null);
	const isLoggingOutRef = useRef(false);
	const menuId = useId();

	const isPasswordPage = pathname === ADMIN_PASSWORD_PATH;
	// The password page returns to the page it was opened from.
	const passwordHref = isPasswordPage ? ADMIN_PASSWORD_PATH : `${ADMIN_PASSWORD_PATH}?from=${encodeURIComponent(pathname)}`;

	useEffect(() =>
	{
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
				settingsButtonRef.current?.focus();
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

	const handleLogout = async () =>
	{
		if (isLoggingOutRef.current)
		{
			return;
		}

		isLoggingOutRef.current = true;
		setLogoutError("");

		try
		{
			// Keeps the guard set on success: the page is navigating away.
			await redirectToLogout();
		}
		catch (error)
		{
			console.error("Błąd wylogowania:", error);
			isLoggingOutRef.current = false;
			setLogoutError("Nie udało się wylogować. Sprawdź połączenie i spróbuj ponownie.");
		}
	};

	return (
		<>
			<header className="relative z-header border-b border-line bg-surface">
				<div className="container mx-auto px-4 py-4">
					<div className="flex items-center justify-between gap-3">
						<Link
							href={ADMIN_HOME_PATH}
							className="focus-ring flex min-w-0 items-center gap-3 rounded-lg">
							<span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-accent text-accent-contrast sm:h-10 sm:w-10">
								<Package className="h-5 w-5 sm:h-6 sm:w-6" aria-hidden="true" />
							</span>
							<span className="flex min-w-0 flex-col leading-tight">
								<span className="truncate text-xl font-bold text-foreground sm:text-2xl">ProjectO</span>
								<span className="truncate text-xs font-medium text-muted">Administracja</span>
							</span>
						</Link>

						<nav aria-label="Panel administratora" className="hidden items-center gap-2 lg:flex">
							{ADMIN_NAV_ITEMS.map(({ href, label, icon: Icon }) =>
							{
								const isActive = isActiveAdminPath(pathname, href);

								return (
									<Link
										key={href}
										href={href}
										aria-current={isActive ? "page" : undefined}
										className="nav-link">
										<Icon className="h-4 w-4" aria-hidden="true" />
										{label}
									</Link>
								);
							})}
						</nav>

						<div className="flex shrink-0 items-center gap-2 sm:gap-4">
							<div className="hidden max-w-56 items-center gap-2 text-sm text-muted xl:flex">
								<UserCircle className="h-5 w-5 shrink-0" aria-hidden="true" />
								<span className="truncate" title={userLabel}>{userLabel}</span>
							</div>
							<div className="relative" ref={settingsRef}>
								<button
									ref={settingsButtonRef}
									type="button"
									onClick={() => setIsSettingsOpen((current) => !current)}
									className={`btn w-11 px-0 ${isPasswordPage ? "btn-primary" : "btn-secondary aria-expanded:bg-surface-hover"}`}
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
										<Link
											href={passwordHref}
											onClick={() => setIsSettingsOpen(false)}
											aria-current={isPasswordPage ? "page" : undefined}
											className="menu-item">
											<KeyRound className="h-4 w-4 shrink-0" aria-hidden="true" />
											Zmień hasło
										</Link>
									</div>
								)}
							</div>
							<button
								type="button"
								onClick={handleLogout}
								className="btn btn-ghost min-w-11 px-2.5 sm:px-4">
								<LogOut className="h-4 w-4 shrink-0" aria-hidden="true" />
								<span className="sr-only sm:not-sr-only">Wyloguj się</span>
							</button>
						</div>
					</div>
				</div>
			</header>

			<nav aria-label="Panel administratora" className="border-b border-line bg-surface lg:hidden">
				<div className="container mx-auto flex gap-2 px-4 py-3">
					{ADMIN_NAV_ITEMS.map(({ href, label, icon: Icon }) =>
					{
						const isActive = isActiveAdminPath(pathname, href);

						return (
							<Link
								key={href}
								href={href}
								aria-current={isActive ? "page" : undefined}
								className={MOBILE_NAV_ITEM_CLASS}>
								<Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
								<span className="max-w-full truncate">{label}</span>
							</Link>
						);
					})}
				</div>
			</nav>

			<div aria-live="polite">
				{logoutError && (
					<p className="border-b border-danger-line bg-danger-soft px-4 py-3 text-center text-sm text-danger-text">
						{logoutError}
					</p>
				)}
			</div>
		</>
	);
}
