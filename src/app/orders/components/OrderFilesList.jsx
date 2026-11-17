"use client";

import { Download, FileText, X } from "lucide-react";

import { ARCHIVED_FILE_META_TEXT } from "../orderUtils";

export default function OrderFilesList({
	actionLabel,
	archived = false,
	attachments,
	busyIds,
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
			<div className="rounded-lg border border-dashed border-line-control px-4 py-6 text-sm text-muted">
				{emptyMessage}
			</div>
		);
	}

	return (
		<div className="space-y-3">
			{attachments.map((attachment, index) => (
				<div
					key={attachment.id}
					className="flex items-center justify-between gap-3 rounded-lg border border-line bg-surface px-3 py-3 sm:px-4">
					<div className="flex min-w-0 flex-1 items-center gap-3">
						<div className="hidden shrink-0 rounded-lg bg-surface-raised p-2 text-muted sm:block">
							<FileText className="h-4 w-4" aria-hidden="true" />
						</div>
						<div className="min-w-0 flex-1">
							{onNameChange ? (
								<input
									aria-label={`Nazwa pliku ${index + 1}`}
									className="field min-w-0 px-2 py-2 sm:py-1.5 sm:text-sm"
									onChange={(event) =>
										onNameChange(event.target.value, attachment, index)
									}
									value={attachment.name}
								/>
							) : (
								<p className="truncate text-sm text-foreground" title={attachment.name}>
									{attachment.name}
								</p>
							)}
							<p className="text-xs text-muted">{archived ? ARCHIVED_FILE_META_TEXT : metaText}</p>
						</div>
					</div>

					{showDownloadButton ? (
						<button
							type="button"
							onClick={() => onDownload?.(attachment, index)}
							disabled={busyIds?.has(attachment.fileId)}
							className="btn btn-primary min-w-11 shrink-0 px-2.5 sm:px-3">
							<Download className="h-4 w-4" aria-hidden="true" />
							<span className="sr-only sm:not-sr-only">
								{busyIds?.has(attachment.fileId) ? "Pobieranie..." : "Pobierz"}
							</span>
						</button>
					) : actionLabel && onAction ? (
						<button
							type="button"
							onClick={() => onAction(attachment, index)}
							className="btn btn-ghost size-11 min-h-0 shrink-0 px-0 hover:text-danger-text">
							<X className="h-4 w-4" aria-hidden="true" />
							<span className="sr-only">{actionLabel}</span>
						</button>
					) : (
						<span className="shrink-0 text-xs text-muted">Dostępny</span>
					)}
				</div>
			))}
		</div>
	);
}
