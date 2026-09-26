"use client";

import { AnimatePresence, motion } from "framer-motion";
import {
	CheckCircle,
	ChevronDown,
	Clock,
	Ellipsis,
	Package,
	PencilLine,
	Trash2,
	XCircle,
} from "lucide-react";

import {
	getDisplayDate,
	getOrderFiles,
	getStatusTheme,
	ORDER_STATUS_VALUES,
} from "../orderUtils";
import OrderFilesList from "./OrderFilesList";

const getStatusIcon = (status) =>
{
	switch (status)
	{
		case "completed":
			return <CheckCircle className="h-4 w-4" />;
		case "in-progress":
		case "pending":
			return <Clock className="h-4 w-4" />;
		case "shipped":
			return <Package className="h-4 w-4" />;
		default:
			return <XCircle className="h-4 w-4" />;
	}
};

export default function OrderCard({
	fileNamesById,
	isAdmin = false,
	isExpanded,
	isMenuOpen,
	isStatusUpdating = false,
	onDownloadFile,
	onOpenEdit,
	onRequestDelete,
	onStatusChange,
	onToggleExpanded,
	onToggleMenu,
	order,
})
{
	const orderFiles = getOrderFiles(order, fileNamesById);
	const statusTheme = getStatusTheme(order.status);

	return (
		<motion.div
			initial={{ opacity: 0, y: 22 }}
			animate={{ opacity: 1, y: 0 }}
			transition={{ duration: 0.42, ease: [0.22, 1, 0.36, 1] }}
			whileHover={{ y: -4 }}
			className={`relative rounded-xl border border-slate-800 bg-slate-900/88 p-6 transition-colors duration-200 hover:border-slate-700 ${
				isMenuOpen ? "z-30" : "z-0"
			}`}>
			<div className="flex items-start justify-between gap-6">
				<div className="flex items-center gap-4">
					<div className="flex h-12 w-12 items-center justify-center rounded-lg bg-white shadow-[0_10px_30px_rgba(255,255,255,0.12)]">
						<Package className="h-6 w-6 text-black" />
					</div>
					<div>
						<h3 className="text-lg font-semibold text-white">{order.patient}</h3>
						<p className="text-slate-300">{order.details || order.type}</p>
						{(order.owner_email || order.owner_user_id) && (
							<p className="text-sm text-sky-300">
								Złożone przez: {order.owner_name || order.owner_last_name
									? `${order.owner_name || ""} ${order.owner_last_name || ""}`.trim()
									: order.owner_email || order.owner_user_id}
								{order.owner_email ? ` (${order.owner_email})` : ""}
							</p>
						)}
						<p className="text-sm text-slate-500">
							Zamówienie #{order.order_id} - {getDisplayDate(order)}
						</p>
					</div>
				</div>

				<div className="flex items-center gap-4">
					<div className="text-right">
						{isAdmin ? (
							<select
								value={order.status}
								disabled={isStatusUpdating}
								onChange={(event) => onStatusChange?.(event.target.value)}
								aria-label={`Zmień status zamówienia ${order.order_id}`}
								className={`rounded-full border-0 px-3 py-1 text-sm font-medium ${statusTheme.badgeClass} focus:outline-none disabled:cursor-wait disabled:opacity-60`}>
								{ORDER_STATUS_VALUES.map((status) => (
									<option key={status} value={status} className="bg-slate-950 text-slate-100">
										{status === "pending"
											? "OCZEKUJĄCE"
											: status === "in-progress"
												? "W REALIZACJI"
												: status === "shipped"
													? "WYSŁANE"
													: "ZAKOŃCZONE"}
									</option>
								))}
							</select>
						) : (
							<span
								className={`inline-flex items-center gap-1 rounded-full px-3 py-1 text-sm font-medium ${statusTheme.badgeClass}`}>
								{getStatusIcon(order.status)}
							{order.status === "pending"
								? "OCZEKUJĄCE"
								: order.status === "in-progress"
									? "W REALIZACJI"
									: order.status === "shipped"
										? "WYSŁANE"
										: "ZAKOŃCZONE"}
							</span>
						)}
						<div className="mt-2 h-2 w-32 rounded-full bg-slate-700">
							<div
								className={`h-2 rounded-full transition-all duration-300 ${statusTheme.progressClass}`}
								style={{
									width: `${order.progress}%`,
								}}
							/>
						</div>
						<p className="mt-1 text-sm text-slate-500">
							{order.progress}% ukończono
						</p>
					</div>

					<button
						type="button"
						onClick={onToggleExpanded}
						className="inline-flex items-center gap-2 self-start rounded-lg border border-slate-700 bg-slate-900 px-4 py-2 text-sm text-slate-200 transition-colors hover:border-slate-500 hover:text-white">
						{isExpanded ? "Ukryj szczegóły" : "Zobacz szczegóły"}
						<ChevronDown
							className={`h-4 w-4 transition-transform ${
								isExpanded ? "rotate-180" : ""
							}`}
						/>
					</button>

					<div className="relative self-start">
						<button
							type="button"
							onClick={onToggleMenu}
							className="inline-flex items-center justify-center rounded-lg border border-slate-700 bg-slate-900 p-2 text-slate-300 transition-colors hover:border-slate-500 hover:text-white"
							aria-label={`Otwórz działania dla zamówienia ${order.order_id}`}>
							<Ellipsis className="h-4 w-4" />
						</button>

						<AnimatePresence>
							{isMenuOpen && (
								<motion.div
									initial={{ opacity: 0, y: 8, scale: 0.98 }}
									animate={{ opacity: 1, y: 0, scale: 1 }}
									exit={{ opacity: 0, y: 8, scale: 0.98 }}
									transition={{ duration: 0.18 }}
									className="absolute right-0 z-40 mt-2 w-56 rounded-xl border border-slate-800 bg-slate-950 p-2 shadow-2xl">
									<button
										type="button"
										onClick={onOpenEdit}
										className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm text-slate-200 transition-colors hover:bg-slate-900 hover:text-white">
										<PencilLine className="h-4 w-4" />
										Edytuj zamówienie
									</button>
									<button
										type="button"
										onClick={onRequestDelete}
										className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm text-red-300 transition-colors hover:bg-red-500/10 hover:text-red-200">
										<Trash2 className="h-4 w-4" />
										Usuń zamówienie
									</button>
								</motion.div>
							)}
						</AnimatePresence>
					</div>
				</div>
			</div>

			<AnimatePresence initial={false}>
				{isExpanded && (
					<motion.div
						initial={{ opacity: 0, height: 0, y: -8 }}
						animate={{ opacity: 1, height: "auto", y: 0 }}
						exit={{ opacity: 0, height: 0, y: -8 }}
						transition={{ duration: 0.32, ease: [0.22, 1, 0.36, 1] }}
						className="overflow-hidden">
						<div className="mt-6 ml-8 rounded-xl border border-slate-800 bg-slate-950 p-5">
							<div className="grid gap-5 md:grid-cols-2">
								<div className="space-y-3">
									<div>
										<p className="text-xs uppercase tracking-[0.2em] text-slate-500">
											Pacjent
										</p>
										<p className="mt-1 text-sm text-white">{order.patient}</p>
									</div>
									<div>
										<p className="text-xs uppercase tracking-[0.2em] text-slate-500">
											Szczegóły
										</p>
										<p className="mt-1 text-sm leading-6 text-slate-300">
											{order.details || "Brak dodatkowych szczegółów."}
										</p>
									</div>
								</div>

								<div>
									<p className="text-xs uppercase tracking-[0.2em] text-slate-500">
										Załączone pliki
									</p>
									<p className="mt-1 text-sm text-slate-400">
										{orderFiles.length} {orderFiles.length === 1 ? "plik" : "plików"}
									</p>

									<div className="mt-4">
										<OrderFilesList
											attachments={orderFiles}
											emptyMessage="Do tego zamówienia nie dodano jeszcze plików."
											onDownload={onDownloadFile}
										/>
									</div>
								</div>
							</div>
						</div>
					</motion.div>
				)}
			</AnimatePresence>
		</motion.div>
	);
}
