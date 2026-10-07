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
			onClick={onToggleExpanded}
			initial={{ opacity: 0, y: 22 }}
			animate={{ opacity: 1, y: 0 }}
			transition={{ duration: 0.42, ease: [0.22, 1, 0.36, 1] }}
			whileHover={{ y: -4 }}
			className={`relative cursor-pointer rounded-xl border border-slate-800 bg-slate-900/88 p-4 transition-colors duration-200 hover:border-slate-700 sm:p-6 ${
				isMenuOpen ? "z-30" : "z-0"
			}`}>
			<div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between md:gap-6">
				<div className="flex min-w-0 items-start gap-3 sm:gap-4 md:items-center">
					<div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-white shadow-[0_10px_30px_rgba(255,255,255,0.12)] sm:h-12 sm:w-12">
						<Package className="h-5 w-5 text-black sm:h-6 sm:w-6" />
					</div>
					<div className="min-w-0">
						<h3 className="text-lg font-semibold text-white wrap-break-word">{order.patient}</h3>
						<p className="text-slate-300 wrap-break-word line-clamp-2 md:line-clamp-none">{order.details || order.type}</p>
						{(order.owner_email || order.owner_user_id) && (
							<p className="text-sm text-sky-300 wrap-anywhere">
								Złożone przez: {order.owner_name || order.owner_last_name
									? `${order.owner_name || ""} ${order.owner_last_name || ""}`.trim()
									: order.owner_email || order.owner_user_id}
								{order.owner_email ? ` (${order.owner_email})` : ""}
							</p>
						)}
						<p className="text-sm text-slate-500">
							Zlecenie #{order.order_id} - {getDisplayDate(order)}
						</p>
					</div>
				</div>

				<div
					className="flex items-center justify-between gap-3 md:shrink-0 md:gap-4"
					onClick={(event) => event.stopPropagation()}
				>
					<div className="min-w-0 md:text-right">
						{isAdmin ? (
							<select
								value={order.status}
								disabled={isStatusUpdating}
								onChange={(event) => onStatusChange?.(event.target.value)}
								aria-label={`Zmień status zlecenia ${order.order_id}`}
								className={`min-h-10 max-w-full rounded-full border-0 px-3 py-2 text-base font-medium sm:min-h-0 sm:py-1 sm:text-sm ${statusTheme.badgeClass} focus:outline-none disabled:cursor-wait disabled:opacity-60`}>
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
								className={`inline-flex items-center gap-1 rounded-full px-3 py-1 text-sm font-medium whitespace-nowrap ${statusTheme.badgeClass}`}>
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

					<div className="flex shrink-0 items-center gap-2 self-start md:gap-4">
						<button
							type="button"
							onClick={(event) =>
							{
								event.stopPropagation();
								onToggleExpanded();
							}}
							aria-expanded={isExpanded}
							className="inline-flex h-10 min-w-10 items-center justify-center gap-2 rounded-lg border border-slate-700 bg-slate-900 px-2.5 text-sm whitespace-nowrap text-slate-200 transition-colors hover:border-slate-500 hover:text-white sm:px-4">
							<span className="sr-only sm:not-sr-only">
								{isExpanded ? "Ukryj szczegóły" : "Zobacz szczegóły"}
							</span>
							<ChevronDown
								className={`h-4 w-4 transition-transform ${
									isExpanded ? "rotate-180" : ""
								}`}
							/>
						</button>

						<div className="relative">
							<button
								type="button"
								onClick={onToggleMenu}
								className="inline-flex h-10 w-10 items-center justify-center rounded-lg border border-slate-700 bg-slate-900 text-slate-300 transition-colors hover:border-slate-500 hover:text-white"
								aria-label={`Otwórz działania dla zlecenia ${order.order_id}`}>
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
											onClick={(event) =>
											{
												event.stopPropagation();
												onOpenEdit();
											}}
											className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm text-slate-200 transition-colors hover:bg-slate-900 hover:text-white">
											<PencilLine className="h-4 w-4" />
											Edytuj zlecenie
										</button>
										<button
											type="button"
											onClick={(event) =>
											{
												event.stopPropagation();
												onRequestDelete();
											}}
											className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm text-red-300 transition-colors hover:bg-red-500/10 hover:text-red-200">
											<Trash2 className="h-4 w-4" />
											Usuń zlecenie
										</button>
									</motion.div>
								)}
							</AnimatePresence>
						</div>
					</div>
				</div>
			</div>

			<AnimatePresence initial={false}>
				{isExpanded && (
					<motion.div
						onClick={(event) => event.stopPropagation()}
						initial={{ opacity: 0, height: 0, y: -8 }}
						animate={{ opacity: 1, height: "auto", y: 0 }}
						exit={{ opacity: 0, height: 0, y: -8 }}
						transition={{ duration: 0.32, ease: [0.22, 1, 0.36, 1] }}
						className="overflow-hidden">
						<div className="mt-4 rounded-xl border border-slate-800 bg-slate-950 p-4 sm:mt-6 sm:p-5 md:ml-8">
							<div className="grid grid-cols-1 gap-5 md:grid-cols-2">
								<div className="min-w-0 space-y-3">
									<div>
										<p className="text-xs uppercase tracking-[0.2em] text-slate-500">
											Pacjent
										</p>
										<p className="mt-1 text-sm text-white wrap-break-word">{order.patient}</p>
									</div>
									<div>
										<p className="text-xs uppercase tracking-[0.2em] text-slate-500">
											Szczegóły
										</p>
										<p className="mt-1 text-sm leading-6 text-slate-300 wrap-break-word">
											{order.details || "Brak dodatkowych szczegółów."}
										</p>
									</div>
								</div>

								<div className="min-w-0">
									<p className="text-xs uppercase tracking-[0.2em] text-slate-500">
										Załączone pliki
									</p>
									<p className="mt-1 text-sm text-slate-400">
										{orderFiles.length} {orderFiles.length === 1 ? "plik" : "plików"}
									</p>

									<div className="mt-4">
										<OrderFilesList
											attachments={orderFiles}
											emptyMessage="Do tego zlecenia nie dodano jeszcze plików."
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
