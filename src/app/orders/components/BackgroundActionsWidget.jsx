"use client";

import { AnimatePresence, motion } from "framer-motion";
import { AlertCircle, CheckCircle2, LoaderCircle } from "lucide-react";

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

export default function BackgroundActionsWidget({ actions })
{
	if (actions.length === 0)
	{
		return null;
	}

	const pendingCount = actions.filter((action) => action.status === "pending").length;

	return (
		<div className="pointer-events-none fixed bottom-4 right-4 z-50 w-[min(24rem,calc(100vw-2rem))]">
			<AnimatePresence>
				<motion.div
					initial={{ opacity: 0, y: 18, scale: 0.98 }}
					animate={{ opacity: 1, y: 0, scale: 1 }}
					exit={{ opacity: 0, y: 18, scale: 0.98 }}
					className="pointer-events-auto overflow-hidden rounded-xl border border-slate-800 bg-slate-950/95 shadow-2xl backdrop-blur-xl">
					<div className="border-b border-slate-800 px-4 py-3">
						<p className="text-xs uppercase tracking-[0.18em] text-slate-500">
							Background Activity
						</p>
						<p className="mt-1 text-sm text-slate-300">
							{pendingCount > 0
								? `${pendingCount} action${pendingCount === 1 ? "" : "s"} running`
								: "Wrapping up"}
						</p>
					</div>

					<div className="max-h-72 space-y-2 overflow-y-auto p-3">
						<AnimatePresence initial={false}>
							{actions.map((action) =>
							{
								const statusStyle = STATUS_STYLES[action.status];
								const StatusIcon = statusStyle.icon;

								return (
									<motion.div
										layout
										key={action.id}
										initial={{ opacity: 0, y: 10 }}
										animate={{ opacity: 1, y: 0 }}
										exit={{ opacity: 0, y: 10 }}
										className="flex items-start gap-3 rounded-lg border border-slate-800 bg-slate-900/75 px-3 py-3">
										<div
											className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full ${statusStyle.iconWrapperClassName}`}>
											<StatusIcon className={`h-4 w-4 ${statusStyle.iconClassName}`} />
										</div>

										<div className="min-w-0 flex-1">
											<p className="truncate text-sm font-medium text-white">
												{action.title}
											</p>
											{action.description ? (
												<p className="mt-1 text-xs text-slate-400">
													{action.description}
												</p>
											) : null}
										</div>
									</motion.div>
								);
							})}
						</AnimatePresence>
					</div>
				</motion.div>
			</AnimatePresence>
		</div>
	);
}
