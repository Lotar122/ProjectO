"use client";

import { AnimatePresence, m } from "framer-motion";
import { useId, useRef } from "react";

import { DIALOG_BACKDROP, DIALOG_PANEL } from "@/app/components/motion";
import useModalA11y from "@/app/components/useModalA11y";

export default function DeleteOrderModal({ isOpen, onCancel, onConfirm, returnFocusRef })
{
	const titleId = useId();
	const descriptionId = useId();
	const cancelRef = useRef(null);
	const dialogRef = useModalA11y({
		isOpen,
		onClose: onCancel,
		initialFocusRef: cancelRef,
		returnFocusRef,
	});

	return (
		<AnimatePresence>
			{isOpen && (
				<m.div
					{...DIALOG_BACKDROP}
					onClick={(event) =>
					{
						if (event.target === event.currentTarget)
						{
							onCancel();
						}
					}}
					className="fixed inset-0 z-overlay flex items-center justify-center bg-overlay p-4">
					<m.div
						ref={dialogRef}
						{...DIALOG_PANEL}
						role="dialog"
						aria-modal="true"
						aria-labelledby={titleId}
						aria-describedby={descriptionId}
						tabIndex={-1}
						className="w-full max-w-sm rounded-xl border border-line bg-surface-raised p-6 shadow-overlay outline-none">
						<h2 id={titleId} className="mb-4 text-lg font-semibold text-foreground">
							Usunąć zlecenie?
						</h2>
						<p id={descriptionId} className="mb-6 text-muted">
							Tej operacji nie można cofnąć.
						</p>
						<div className="flex justify-end gap-3">
							<button
								ref={cancelRef}
								type="button"
								onClick={onCancel}
								className="btn btn-secondary min-w-24">
								Anuluj
							</button>
							<button
								type="button"
								onClick={onConfirm}
								className="btn btn-danger">
								Usuń zlecenie
							</button>
						</div>
					</m.div>
				</m.div>
			)}
		</AnimatePresence>
	);
}
