"use client";

import { AnimatePresence, m } from "framer-motion";
import { useId, useRef } from "react";

import useModalA11y from "@/app/components/useModalA11y";

export default function DeleteOrderModal({ isOpen, onCancel, onConfirm, returnFocusRef })
{
	const titleId = useId();
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
					initial={{ opacity: 0 }}
					animate={{ opacity: 1, pointerEvents: "auto" }}
					exit={{ opacity: 0, pointerEvents: "none" }}
					onClick={(event) =>
					{
						if (event.target === event.currentTarget)
						{
							onCancel();
						}
					}}
					className="fixed inset-0 z-50 flex items-center justify-center bg-overlay p-4">
					<m.div
						ref={dialogRef}
						initial={{ opacity: 0, scale: 0.94, y: 18 }}
						animate={{ opacity: 1, scale: 1, y: 0, pointerEvents: "auto" }}
						exit={{ opacity: 0, scale: 0.96, pointerEvents: "none" }}
						role="dialog"
						aria-modal="true"
						aria-labelledby={titleId}
						tabIndex={-1}
						className="w-full max-w-sm rounded-xl border border-line bg-surface-raised p-6 outline-none">
						<h2 id={titleId} className="mb-4 text-lg font-semibold text-foreground">
							Usunąć zlecenie?
						</h2>
						<p className="mb-6 text-muted">
							Czy na pewno chcesz usunąć to zlecenie? Tej operacji nie można
							cofnąć.
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
								className="btn btn-danger min-w-24">
								Usuń
							</button>
						</div>
					</m.div>
				</m.div>
			)}
		</AnimatePresence>
	);
}
