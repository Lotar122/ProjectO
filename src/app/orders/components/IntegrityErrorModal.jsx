"use client";

import { AnimatePresence, m } from "framer-motion";
import { useId, useRef } from "react";

import { DIALOG_BACKDROP, DIALOG_PANEL } from "@/app/components/motion";
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
					{...DIALOG_BACKDROP}
					className="fixed inset-0 z-overlay flex items-center justify-center bg-overlay p-4">
					<m.div
						ref={dialogRef}
						{...DIALOG_PANEL}
						role="alertdialog"
						aria-modal="true"
						aria-labelledby={titleId}
						aria-describedby={descriptionId}
						tabIndex={-1}
						className="w-full max-w-sm rounded-xl border border-line bg-surface-raised p-6 shadow-overlay outline-none">
						<h2 id={titleId} className="mb-4 text-lg font-semibold text-danger-text">
							{error.title}
						</h2>
						<p id={descriptionId} className="text-muted">{error.message}</p>
						{error.files?.length > 0 && (
							<ul className="mt-4 list-inside list-disc text-sm text-foreground">
								{error.files.map((fileName, index) => (
									<li key={`${index}-${fileName}`} className="break-all">
										{fileName}
									</li>
								))}
							</ul>
						)}
						<div className="mt-6 flex justify-end">
							<button
								ref={okRef}
								type="button"
								onClick={onClose}
								className="btn btn-secondary min-w-24">
								Zamknij
							</button>
						</div>
					</m.div>
				</m.div>
			)}
		</AnimatePresence>
	);
}
