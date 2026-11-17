"use client";

import { AnimatePresence, m } from "framer-motion";
import { AlertCircle, CheckCircle2, LoaderCircle, X } from "lucide-react";
import { memo } from "react";

const STATUS_STYLES = {
	pending: {
		icon: LoaderCircle,
		iconClassName: "animate-spin text-foreground",
		iconWrapperClassName: "bg-surface-raised",
	},
	success: {
		icon: CheckCircle2,
		iconClassName: "text-success-text",
		iconWrapperClassName: "bg-success-soft",
	},
	error: {
		icon: AlertCircle,
		iconClassName: "text-danger-text",
		iconWrapperClassName: "bg-danger-soft",
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
						className="pointer-events-auto overflow-hidden rounded-xl border border-line bg-surface-raised shadow-2xl">
						<div className="border-b border-line px-4 py-3">
							<p className="text-xs uppercase tracking-[0.18em] text-muted">
								Działania w tle
							</p>
							<p className="mt-1 text-sm text-foreground">
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
										className="flex items-start gap-3 rounded-lg border border-line bg-surface px-3 py-3">
										<div
											className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full ${statusStyle.iconWrapperClassName}`}>
											<StatusIcon className={`h-4 w-4 ${statusStyle.iconClassName}`} aria-hidden="true" />
										</div>

										<div className="min-w-0 flex-1">
											<p className="truncate text-sm font-medium text-foreground">
												{action.title}
											</p>
											{action.description ? (
												<p className="mt-1 text-xs wrap-break-word text-muted">
													{action.description}
												</p>
											) : null}
										</div>

										<button
											type="button"
											onClick={() => onDismiss(action.id)}
											aria-label="Zamknij powiadomienie"
											className="btn btn-ghost size-9 min-h-0 shrink-0 px-0">
											<X className="h-4 w-4" aria-hidden="true" />
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
