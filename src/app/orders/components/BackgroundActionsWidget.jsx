"use client";

import { AnimatePresence, m } from "framer-motion";
import { AlertCircle, CheckCircle2, LoaderCircle, X } from "lucide-react";
import { memo } from "react";

const STATUS_STYLES = {
	pending: {
		icon: LoaderCircle,
		iconClassName: "animate-spin text-slate-200",
		iconWrapperClassName: "bg-slate-800/80",
	},
	success: {
		icon: CheckCircle2,
		iconClassName: "text-emerald-300",
		iconWrapperClassName: "bg-emerald-500/12",
	},
	error: {
		icon: AlertCircle,
		iconClassName: "text-red-300",
		iconWrapperClassName: "bg-red-500/12",
	},
};

function BackgroundActionsWidget({ actions, onDismiss })
{
	const pendingCount = actions.filter((action) => action.status === "pending").length;

	return (
		<div className="pointer-events-none fixed bottom-4 right-4 z-50 w-[min(24rem,calc(100vw-2rem))]">
			<AnimatePresence initial={false}>
				{actions.length > 0 && (
					<m.div
						key="widget"
						initial={{ opacity: 0, y: 18 }}
						animate={{ opacity: 1, y: 0 }}
						exit={{ opacity: 0, y: 18 }}
						className="pointer-events-auto overflow-hidden rounded-xl border border-slate-800 bg-slate-950 shadow-2xl">
						<div className="border-b border-slate-800 px-4 py-3">
							<p className="text-xs uppercase tracking-[0.18em] text-slate-500">
								Działania w tle
							</p>
							<p className="mt-1 text-sm text-slate-300">
								{pendingCount > 0
									? `W toku: ${pendingCount} ${pendingCount === 1 ? "działanie" : "działania"}`
									: "Kończenie działań"}
							</p>
						</div>

						<div className="max-h-[min(18rem,40dvh)] space-y-2 overflow-y-auto p-3">
							{actions.map((action) =>
							{
								const statusStyle = STATUS_STYLES[action.status];
								const StatusIcon = statusStyle.icon;

								return (
									<div
										key={action.id}
										className="flex items-start gap-3 rounded-lg border border-slate-800 bg-slate-900 px-3 py-3">
										<div
											className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full ${statusStyle.iconWrapperClassName}`}>
											<StatusIcon className={`h-4 w-4 ${statusStyle.iconClassName}`} />
										</div>

										<div className="min-w-0 flex-1">
											<p className="truncate text-sm font-medium text-white">
												{action.title}
											</p>
											{action.description ? (
												<p className="mt-1 text-xs wrap-break-word text-slate-400">
													{action.description}
												</p>
											) : null}
										</div>

										<button
											type="button"
											onClick={() => onDismiss(action.id)}
											aria-label="Zamknij powiadomienie"
											className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-slate-500 transition-colors hover:bg-slate-800 hover:text-white">
											<X className="h-4 w-4" />
										</button>
									</div>
								);
							})}
						</div>
					</m.div>
				)}
			</AnimatePresence>
		</div>
	);
}

export default memo(BackgroundActionsWidget);
