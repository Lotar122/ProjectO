"use client";

import { motion } from "framer-motion";
import { Download, FileText, X } from "lucide-react";

export default function OrderFilesList({
	actionLabel,
	actionTextClassName = "text-sm text-slate-400 hover:text-red-400",
	attachments,
	emptyMessage,
	metaText = "Gotowe do pobrania w tej sesji",
	onAction,
	onDownload,
	onNameChange,
	showDownloadButton = true,
})
{
	if (attachments.length === 0)
	{
		return (
			<div className="rounded-lg border border-dashed border-slate-800 px-4 py-6 text-sm text-slate-500">
				{emptyMessage}
			</div>
		);
	}

	return (
		<div className="space-y-3">
			{attachments.map((attachment, index) => (
				<motion.div
					key={attachment.id}
					initial={{ opacity: 0, y: 10 }}
					animate={{ opacity: 1, y: 0 }}
					className="flex items-center justify-between gap-3 rounded-lg border border-slate-800 bg-slate-900 px-3 py-3 sm:px-4">
					<div className="flex min-w-0 flex-1 items-center gap-3">
						<div className="hidden shrink-0 rounded-lg bg-slate-800 p-2 text-slate-300 sm:block">
							<FileText className="h-4 w-4" />
						</div>
						<div className="min-w-0 flex-1">
							{onNameChange ? (
								<input
									aria-label={`Nazwa pliku ${index + 1}`}
									className="w-full min-w-0 rounded border border-slate-700 bg-slate-950 px-2 py-2 text-base text-white focus:border-slate-500 focus:outline-none sm:py-1.5 sm:text-sm"
									onChange={(event) =>
										onNameChange(event.target.value, attachment, index)
									}
									value={attachment.name}
								/>
							) : (
								<p className="truncate text-sm text-white" title={attachment.name}>
									{attachment.name}
								</p>
							)}
							<p className="text-xs text-slate-500">{metaText}</p>
						</div>
					</div>

					{showDownloadButton ? (
						<button
							type="button"
							onClick={() => onDownload?.(attachment, index)}
							className="inline-flex h-10 min-w-10 shrink-0 items-center justify-center gap-2 rounded-lg bg-white px-2.5 text-sm font-medium text-black transition-colors hover:bg-gray-200 sm:px-3">
							<Download className="h-4 w-4" />
							<span className="sr-only sm:not-sr-only">Pobierz</span>
						</button>
					) : actionLabel && onAction ? (
						<button
							type="button"
							onClick={() => onAction(attachment, index)}
							className={`inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-lg ${actionTextClassName}`}>
							<X className="h-4 w-4" />
							<span className="sr-only">{actionLabel}</span>
						</button>
					) : (
						<span className="shrink-0 text-xs text-slate-500">Dostępny</span>
					)}
				</motion.div>
			))}
		</div>
	);
}
