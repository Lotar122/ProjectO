"use client";

import { AnimatePresence, motion } from "framer-motion";

export default function DeleteOrderModal({ isOpen, onCancel, onConfirm }) {
	return (
		<AnimatePresence>
			{isOpen && (
				<div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
					<motion.div
						initial={{ opacity: 0, scale: 0.94, y: 18 }}
						animate={{ opacity: 1, scale: 1, y: 0 }}
						exit={{ opacity: 0, scale: 0.96 }}
						className="w-80 rounded-xl bg-gray-900 p-6">
						<h2 className="mb-4 text-lg font-semibold text-white">
							Delete Order?
						</h2>
						<p className="mb-6 text-gray-400">
							Are you sure you want to delete this order? This action cannot be
							undone.
						</p>
						<div className="flex justify-end gap-4">
							<button
								type="button"
								onClick={onCancel}
								className="rounded bg-gray-700 px-4 py-2 transition-colors hover:bg-gray-600">
								Cancel
							</button>
							<button
								type="button"
								onClick={onConfirm}
								className="rounded bg-red-600 px-4 py-2 text-white transition-colors hover:bg-red-500">
								Delete
							</button>
						</div>
					</motion.div>
				</div>
			)}
		</AnimatePresence>
	);
}
