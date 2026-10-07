"use client";

import { AnimatePresence, motion } from "framer-motion";
import { useId } from "react";

export default function DeleteOrderModal({ isOpen, onCancel, onConfirm })
{
	const titleId = useId();

	return (
		<AnimatePresence>
			{isOpen && (
				<div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm">
					<motion.div
						initial={{ opacity: 0, scale: 0.94, y: 18 }}
						animate={{ opacity: 1, scale: 1, y: 0 }}
						exit={{ opacity: 0, scale: 0.96 }}
						role="dialog"
						aria-modal="true"
						aria-labelledby={titleId}
						className="w-full max-w-sm rounded-xl bg-gray-900 p-6">
						<h2 id={titleId} className="mb-4 text-lg font-semibold text-white">
							Usunąć zlecenie?
						</h2>
						<p className="mb-6 text-gray-400">
							Czy na pewno chcesz usunąć to zlecenie? Tej operacji nie można
							cofnąć.
						</p>
						<div className="flex justify-end gap-4">
							<button
								type="button"
								onClick={onCancel}
								className="min-w-24 rounded bg-gray-700 px-4 py-2.5 transition-colors hover:bg-gray-600">
								Anuluj
							</button>
							<button
								type="button"
								onClick={onConfirm}
								className="min-w-24 rounded bg-red-600 px-4 py-2.5 text-white transition-colors hover:bg-red-500">
								Usuń
							</button>
						</div>
					</motion.div>
				</div>
			)}
		</AnimatePresence>
	);
}
