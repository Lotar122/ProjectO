"use client";

import { motion } from "framer-motion";
import { LogOut, Package, Plus, Settings, UserCircle } from "lucide-react";
import { useEffect, useRef, useState } from "react";

export default function OrdersHeader({
	currentPage,
	onLogout,
	onShowChangePassword,
	onShowCreateOrder,
	onShowOrders,
	userLastName,
	userName,
})
{
	const [isSettingsOpen, setIsSettingsOpen] = useState(false);
	const settingsRef = useRef(null);

	useEffect(() =>
	{
		const handlePointerDown = (event) =>
		{
			if (!settingsRef.current?.contains(event.target))
			{
				setIsSettingsOpen(false);
			}
		};

		document.addEventListener("mousedown", handlePointerDown);

		return () =>
		{
			document.removeEventListener("mousedown", handlePointerDown);
		};
	}, []);

	return (
		<>
			<motion.header
				initial={{ opacity: 0, y: -18 }}
				animate={{ opacity: 1, y: 0 }}
				transition={{ duration: 0.45 }}
				className="border-b border-slate-800 bg-slate-900/90 backdrop-blur-xl">
				<div className="container mx-auto px-4 py-4">
					<div className="flex items-center justify-between">
						<div className="flex items-center gap-3">
							<div className="flex h-10 w-10 items-center justify-center rounded-lg bg-white shadow-[0_12px_40px_rgba(255,255,255,0.12)]">
								<Package className="h-6 w-6 text-black" />
							</div>
							<h1 className="text-2xl font-bold text-white">ProjectO</h1>
						</div>

						<nav className="hidden items-center gap-6 md:flex">
							<button
								type="button"
								onClick={onShowOrders}
								className={`flex items-center gap-2 rounded-lg px-3 py-2 transition-colors ${
									currentPage === "orders"
										? "bg-white text-black"
										: "text-gray-300 hover:text-white"
								}`}>
								<Package className="h-4 w-4" />
								Orders
							</button>
							<button
								type="button"
								onClick={onShowCreateOrder}
								className={`flex items-center gap-2 rounded-lg px-3 py-2 transition-colors ${
									currentPage === "create-order"
										? "bg-white text-black"
										: "text-gray-300 hover:text-white"
								}`}>
								<Plus className="h-4 w-4" />
								New Order
							</button>
						</nav>

						<div className="flex items-center gap-4">
							<div className="hidden items-center gap-2 text-sm text-gray-300 md:flex">
								<UserCircle className="h-5 w-5" />
								Dr. {userLastName || userName}
							</div>
							<div className="relative" ref={settingsRef}>
								<button
									type="button"
									onClick={() => setIsSettingsOpen((current) => !current)}
									className="flex items-center gap-2 rounded-xl border border-slate-800 bg-slate-950/70 px-3 py-2 text-gray-300 transition-colors hover:border-slate-600 hover:text-white"
									aria-expanded={isSettingsOpen}
									aria-haspopup="menu"
									aria-label="Open settings">
									<Settings className="h-4 w-4" />
								</button>

								{isSettingsOpen && (
									<div className="absolute right-0 top-full z-20 mt-2 min-w-52 overflow-hidden rounded-2xl border border-slate-800 bg-slate-950/95 shadow-[0_20px_60px_rgba(0,0,0,0.45)] backdrop-blur-xl">
										<button
											type="button"
											onClick={() =>
											{
												setIsSettingsOpen(false);
												onShowChangePassword();
											}}
											className="flex w-full items-center gap-3 px-4 py-3 text-left text-sm text-slate-200 transition-colors hover:bg-slate-900 hover:text-white"
											role="menuitem">
											<Settings className="h-4 w-4" />
											Change password
										</button>
									</div>
								)}
							</div>
							<button
								type="button"
								onClick={onLogout}
								className="flex items-center gap-2 px-4 py-2 text-gray-300 transition-colors hover:text-white">
								<LogOut className="h-4 w-4" />
								Logout
							</button>
						</div>
					</div>
				</div>
			</motion.header>

			<div className="border-b border-slate-800 bg-slate-900/90 backdrop-blur-xl md:hidden">
				<div className="container mx-auto px-4 py-3">
					<div className="flex gap-2">
						<button
							type="button"
							onClick={onShowOrders}
							className={`flex flex-1 items-center justify-center gap-2 rounded-lg px-3 py-2 transition-colors ${
								currentPage === "orders"
									? "bg-white text-slate-950"
									: "text-slate-300"
							}`}>
							<Package className="h-4 w-4" />
							Orders
						</button>
						<button
							type="button"
							onClick={onShowCreateOrder}
							className={`flex flex-1 items-center justify-center gap-2 rounded-lg px-3 py-2 transition-colors ${
								currentPage === "create-order"
									? "bg-white text-slate-950"
									: "text-slate-300"
							}`}>
							<Plus className="h-4 w-4" />
							New
						</button>
					</div>
				</div>
			</div>
		</>
	);
}
