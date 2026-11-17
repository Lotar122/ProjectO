"use client";

import { AnimatePresence, m } from "framer-motion";
import { useId } from "react";

export default function DeleteOrderModal({ isOpen, onCancel, onConfirm })
{
	const titleId = useId();

	return (
		<AnimatePresence>
			{isOpen && (
				<div className="fixed inset-0 z-50 flex items-center justify-center bg-overlay p-4">
					<m.div
						initial={{ opacity: 0, scale: 0.94, y: 18 }}
						animate={{ opacity: 1, scale: 1, y: 0 }}
						exit={{ opacity: 0, scale: 0.96 }}
						role="dialog"
						aria-modal="true"
						aria-labelledby={titleId}
						className="w-full max-w-sm rounded-xl border border-line bg-surface-raised p-6">
						<h2 id={titleId} className="mb-4 text-lg font-semibold text-foreground">
							Usunąć zlecenie?
						</h2>
						<p className="mb-6 text-muted">
							Czy na pewno chcesz usunąć to zlecenie? Tej operacji nie można
							cofnąć.
						</p>
						<div className="flex justify-end gap-3">
							<button
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
				</div>
			)}
		</AnimatePresence>
	);
}
