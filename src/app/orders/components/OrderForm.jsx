"use client";

import { motion } from "framer-motion";

import OrderFilesList from "./OrderFilesList";

export default function OrderForm({
	attachments = [],
	cancelLabel = "Cancel",
	description,
	details,
	dueDate,
	files = [],
	fileSectionMode,
	onCancel,
	onDetailsChange,
	onDueDateChange,
	onFilesSelected,
	onPatientChange,
	onRemoveFile,
	onSubmit,
	patient,
	submitLabel,
	title,
}) {
	return (
		<>
			<div className="mb-8">
				<h2 className="mb-2 text-3xl font-bold text-white">{title}</h2>
				<p className="text-slate-400">{description}</p>
			</div>

			<div className="mx-auto max-w-2xl rounded-xl border border-slate-800 bg-slate-900/88 p-8 backdrop-blur">
				<form onSubmit={onSubmit} className="space-y-6">
					<div>
						<label className="mb-2 block text-sm font-medium text-slate-300">
							Patient Name
						</label>
						<input
							type="text"
							value={patient}
							onChange={(event) => onPatientChange(event.target.value)}
							className="w-full rounded-lg border border-slate-700 bg-slate-950 px-4 py-3 text-slate-100 transition-all duration-300 focus:border-slate-500 focus:ring-2 focus:ring-slate-400/20 focus:outline-none"
							placeholder="Enter patient full name"
							required
						/>
					</div>

					<div>
						<label className="mb-2 block text-sm font-medium text-slate-300">
							Details
						</label>
						<input
							type="text"
							value={details}
							onChange={(event) => onDetailsChange(event.target.value)}
							className="w-full rounded-lg border border-slate-700 bg-slate-950 px-4 py-3 text-slate-100 transition-all duration-300 focus:border-slate-500 focus:ring-2 focus:ring-slate-400/20 focus:outline-none"
							placeholder="Enter type"
							required
						/>
					</div>

					<div>
						<label className="mb-2 block text-sm font-medium text-slate-300">
							Due date
						</label>
						<input
							type="date"
							value={dueDate}
							onChange={(event) => onDueDateChange(event.target.value)}
							className="w-full rounded-lg border border-slate-700 bg-slate-950 px-4 py-3 text-slate-100 transition-all duration-300 focus:border-slate-500 focus:ring-2 focus:ring-slate-400/20 focus:outline-none"
							required
						/>
					</div>

					<div>
						<label className="mb-2 block text-sm font-medium text-slate-300">
							{fileSectionMode === "create" ? "Attach Files" : "File Management"}
						</label>

						{fileSectionMode === "create" ? (
							<>
								<label className="flex h-32 w-full cursor-pointer flex-col items-center justify-center rounded-lg border-2 border-dashed border-slate-700 bg-slate-950/60 transition hover:border-slate-500">
									<span className="text-sm text-slate-400">
										Click or drag files
									</span>
									<input
										type="file"
										multiple
										onChange={(event) =>
											onFilesSelected?.(Array.from(event.target.files || []))
										}
										className="hidden"
									/>
								</label>

								<div className="mt-3 space-y-2">
									{files.map((file, index) => (
										<div
											key={`${file.name}-${index}`}
											className="flex items-center justify-between rounded-lg border border-slate-800 bg-slate-950 px-3 py-2">
											<span className="truncate text-sm text-slate-100">
												{file.name}
											</span>

											<button
												type="button"
												onClick={() => onRemoveFile?.(index)}
												className="text-sm text-slate-400 hover:text-red-400">
												X
											</button>
										</div>
									))}
								</div>
							</>
						) : (
							<>
								<label className="flex h-32 w-full flex-col items-center justify-center rounded-lg border-2 border-dashed border-slate-700 bg-slate-950/60">
									<span className="text-sm text-slate-400">
										Upload or replace files later
									</span>
									<span className="mt-1 text-xs text-slate-500">
										UI only for now, no functionality connected
									</span>
								</label>

								<div className="mt-3">
									<OrderFilesList
										attachments={attachments}
										emptyMessage="No files attached to this order yet."
										metaText="Ready in the current session"
										showDownloadButton={false}
									/>
								</div>
							</>
						)}
					</div>

					<div className="flex gap-4">
						<motion.button
							type="submit"
							whileHover={{ scale: 1.02, y: -1 }}
							whileTap={{ scale: 0.985 }}
							className="flex-1 rounded-lg bg-white py-3 font-semibold text-black transition-colors duration-200 hover:bg-gray-200">
							{submitLabel}
						</motion.button>
						<button
							type="button"
							onClick={onCancel}
							className="flex-1 rounded-lg bg-slate-800 py-3 font-semibold text-white transition-colors duration-200 hover:bg-slate-700">
							{cancelLabel}
						</button>
					</div>
				</form>
			</div>
		</>
	);
}
