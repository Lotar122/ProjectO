"use client";

import { AnimatePresence, motion } from "framer-motion";
import { useId } from "react";

export default function IntegrityErrorModal({ error, onClose })
{
	const titleId = useId();

	return (
		<AnimatePresence>
			{error && (
				<div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm">
					<motion.div
						initial={{ opacity: 0, scale: 0.94, y: 18 }}
						animate={{ opacity: 1, scale: 1, y: 0 }}
						exit={{ opacity: 0, scale: 0.96 }}
						role="alertdialog"
						aria-modal="true"
						aria-labelledby={titleId}
						className="w-full max-w-sm rounded-xl bg-gray-900 p-6">
						<h2 id={titleId} className="mb-4 text-lg font-semibold text-red-400">
							{error.title}
						</h2>
						<p className="mb-4 text-gray-400">{error.message}</p>
						{error.files?.length > 0 && (
							<ul className="mb-6 list-inside list-disc text-sm text-gray-300">
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
								className="min-w-24 rounded bg-gray-700 px-4 py-2.5 transition-colors hover:bg-gray-600">
								OK
							</button>
						</div>
					</motion.div>
				</div>
			)}
		</AnimatePresence>
	);
}
