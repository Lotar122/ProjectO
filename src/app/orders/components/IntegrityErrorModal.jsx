"use client";

import { AnimatePresence, m } from "framer-motion";
import { useId, useRef } from "react";

import useModalA11y from "@/app/components/useModalA11y";

export default function IntegrityErrorModal({ error, onClose })
{
	const titleId = useId();
	const descriptionId = useId();
	const okRef = useRef(null);
	const dialogRef = useModalA11y({ isOpen: Boolean(error), onClose, initialFocusRef: okRef });

	return (
		<AnimatePresence>
			{error && (
				<m.div
					initial={{ opacity: 0 }}
					animate={{ opacity: 1, pointerEvents: "auto" }}
					exit={{ opacity: 0, pointerEvents: "none" }}
					className="fixed inset-0 z-50 flex items-center justify-center bg-overlay p-4">
					<m.div
						ref={dialogRef}
						initial={{ opacity: 0, scale: 0.94, y: 18 }}
						animate={{ opacity: 1, scale: 1, y: 0, pointerEvents: "auto" }}
						exit={{ opacity: 0, scale: 0.96, pointerEvents: "none" }}
						role="alertdialog"
						aria-modal="true"
						aria-labelledby={titleId}
						aria-describedby={descriptionId}
						tabIndex={-1}
						className="w-full max-w-sm rounded-xl border border-line bg-surface-raised p-6 outline-none">
						<h2 id={titleId} className="mb-4 text-lg font-semibold text-danger-text">
							{error.title}
						</h2>
						<p id={descriptionId} className="mb-4 text-muted">{error.message}</p>
						{error.files?.length > 0 && (
							<ul className="mb-6 list-inside list-disc text-sm text-foreground">
								{error.files.map((fileName, index) => (
									<li key={`${index}-${fileName}`} className="break-all">
										{fileName}
									</li>
								))}
							</ul>
						)}
						<div className="flex justify-end">
							<button
								ref={okRef}
								type="button"
								onClick={onClose}
								className="btn btn-secondary min-w-24">
								OK
							</button>
						</div>
					</m.div>
				</m.div>
			)}
		</AnimatePresence>
	);
}
