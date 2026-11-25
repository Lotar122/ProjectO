"use client";

import { AnimatePresence, m } from "framer-motion";
import { AlertCircle, CheckCircle2, LoaderCircle, X } from "lucide-react";
import { memo, useEffect, useRef, useState } from "react";

import { SECTION_ENTER } from "@/app/components/motion";
import { pluralPl } from "@/app/lib/pluralPl";

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
	const [announcement, setAnnouncement] = useState("");
	const seenStatusesRef = useRef(new Map());

	useEffect(() =>
	{
		const seenStatuses = seenStatusesRef.current;
		const currentIds = new Set(actions.map((action) => action.id));

		for (const action of actions)
		{
			if (action.status !== "pending" && seenStatuses.get(action.id) !== action.status)
			{
				const outcome = action.status === "success" ? "zakończone" : "nie powiodło się";
				setAnnouncement(`${action.title}: ${outcome}`);
			}
			seenStatuses.set(action.id, action.status);
		}

		for (const id of seenStatuses.keys())
		{
			if (!currentIds.has(id))
			{
				seenStatuses.delete(id);
			}
		}
	}, [actions]);

	return (
		<div className="pointer-events-none fixed bottom-[calc(1rem+env(safe-area-inset-bottom))] right-4 z-toast w-[min(24rem,calc(100vw-2rem))]">
			<p className="sr-only" aria-live="polite">{announcement}</p>
			<AnimatePresence initial={false}>
				{actions.length > 0 && (
					<m.div
						key="widget"
						{...SECTION_ENTER}
						exit={{ opacity: 0, y: 8 }}
						className="pointer-events-auto overflow-hidden rounded-xl border border-line bg-surface-raised shadow-overlay">
						<div className="border-b border-line px-4 py-3">
							<p className="eyebrow">
								Działania w tle
							</p>
							<p className="mt-1 text-sm text-foreground">
								{pendingCount > 0
									? `W toku: ${pendingCount} ${pluralPl(pendingCount, ["działanie", "działania", "działań"])}`
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
											<p className="truncate text-sm font-medium text-foreground" title={action.title}>
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
