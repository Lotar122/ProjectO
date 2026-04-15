"use client";

import { motion } from "framer-motion";
import { Download, FileText } from "lucide-react";

export default function OrderFilesList({
	attachments,
	emptyMessage,
	metaText = "Ready to download in this session",
	onDownload,
	showDownloadButton = true,
}) {
	if (attachments.length === 0) {
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
					className="flex items-center justify-between gap-3 rounded-lg border border-slate-800 bg-slate-900 px-4 py-3">
					<div className="flex min-w-0 items-center gap-3">
						<div className="rounded-lg bg-slate-800 p-2 text-slate-300">
							<FileText className="h-4 w-4" />
						</div>
						<div className="min-w-0">
							<p className="truncate text-sm text-white">{attachment.name}</p>
							<p className="text-xs text-slate-500">{metaText}</p>
						</div>
					</div>

					{showDownloadButton ? (
						<button
							type="button"
							onClick={() => onDownload?.(attachment, index)}
							className="inline-flex items-center gap-2 rounded-lg bg-white px-3 py-2 text-sm font-medium text-black transition-colors hover:bg-gray-200">
							<Download className="h-4 w-4" />
							Download
						</button>
					) : (
						<span className="text-xs text-slate-500">Available</span>
					)}
				</motion.div>
			))}
		</div>
	);
}
