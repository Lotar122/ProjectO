"use client";

import { AnimatePresence, m } from "framer-motion";
import { useId } from "react";

export default function IntegrityErrorModal({ error, onClose })
{
	const titleId = useId();

	return (
		<AnimatePresence>
			{error && (
				<div className="fixed inset-0 z-50 flex items-center justify-center bg-overlay p-4">
					<m.div
						initial={{ opacity: 0, scale: 0.94, y: 18 }}
						animate={{ opacity: 1, scale: 1, y: 0 }}
						exit={{ opacity: 0, scale: 0.96 }}
						role="alertdialog"
						aria-modal="true"
						aria-labelledby={titleId}
						className="w-full max-w-sm rounded-xl border border-line bg-surface-raised p-6">
						<h2 id={titleId} className="mb-4 text-lg font-semibold text-danger-text">
							{error.title}
						</h2>
						<p className="mb-4 text-muted">{error.message}</p>
						{error.files?.length > 0 && (
							<ul className="mb-6 list-inside list-disc text-sm text-foreground">
								{error.files.map((fileName) => (
									<li key={fileName} className="break-all">
										{fileName}
									</li>
								))}
							</ul>
						)}
						<div className="flex justify-end">
							<button
								type="button"
								onClick={onClose}
								className="btn btn-secondary min-w-24">
								OK
							</button>
						</div>
					</m.div>
				</div>
			)}
		</AnimatePresence>
	);
}
