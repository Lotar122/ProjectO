"use client";

import { useId } from "react";
import { getLocalFileKey } from "../orderUtils";
import FileDropzone from "./FileDropzone";
import OrderFilesList from "./OrderFilesList";

export default function OrderForm({
	attachments = [],
	cancelLabel = "Anuluj",
	description,
	details,
	detailsRequired = true,
	dueDate,
	files = [],
	fileSectionMode,
	onCancel,
	onDetailsChange,
	onDueDateChange,
	onFilesSelected,
	onPatientChange,
	onRemoveAttachment,
	onAttachmentNameChange,
	onRemoveFile,
	onSubmit,
	patient,
	submitLabel,
	title,
})
{
	const id = useId();
	const isCreate = fileSectionMode === "create";

	return (
		<>
			<div className="mb-6 sm:mb-8">
				<h2 className="mb-2 text-2xl font-bold text-foreground sm:text-3xl">{title}</h2>
				<p className="text-muted">{description}</p>
			</div>

			<div className="mx-auto max-w-2xl rounded-xl border border-line bg-surface p-4 sm:p-8">
				<form onSubmit={onSubmit} className="space-y-6">
					<div>
						<label htmlFor={`${id}-patient`} className="field-label">
							Imię i nazwisko pacjenta
						</label>
						<input
							id={`${id}-patient`}
							type="text"
							value={patient}
							onChange={(event) => onPatientChange(event.target.value)}
							className="field"
							placeholder="Wpisz imię i nazwisko pacjenta"
							required
						/>
					</div>

					<div>
						<label htmlFor={`${id}-details`} className="field-label">
							Szczegóły
						</label>
						<textarea
							id={`${id}-details`}
							value={details}
							onChange={(event) => onDetailsChange(event.target.value)}
							rows={5}
							className="field resize-y"
							placeholder="Wpisz szczegóły zlecenia"
							required={detailsRequired}
						/>
					</div>

					<div>
						<label htmlFor={`${id}-dueDate`} className="field-label">
							Termin realizacji
						</label>
						<input
							id={`${id}-dueDate`}
							type="date"
							value={dueDate}
							onChange={(event) => onDueDateChange(event.target.value)}
							className="field min-h-12 [&::-webkit-date-and-time-value]:text-left"
							required
						/>
					</div>

					<div>
						<FileDropzone
							hint={isCreate ? undefined : "Usuń niepotrzebne pliki i dodaj nowe przed zapisaniem"}
							label={isCreate ? "Dodaj pliki" : "Zarządzanie plikami"}
							onFilesSelected={onFilesSelected}
						/>

						<div className="mt-3">
							{isCreate ? (
								<OrderFilesList
									attachments={files.map((file) => ({
										id: getLocalFileKey(file),
										name: file.name,
									}))}
									actionLabel="Usuń plik"
									emptyMessage="Nie dodano jeszcze plików."
									metaText="Gotowe w bieżącej sesji"
									onAction={(_, index) => onRemoveFile?.(index)}
									showDownloadButton={false}
								/>
							) : (
								<OrderFilesList
									attachments={attachments}
									actionLabel="Usuń plik"
									emptyMessage="Do tego zlecenia nie dodano jeszcze plików."
									metaText="Gotowe w bieżącej sesji"
									onAction={onRemoveAttachment}
									onNameChange={onAttachmentNameChange}
									showDownloadButton={false}
								/>
							)}
						</div>
					</div>

					<div className="flex flex-col gap-3 sm:flex-row sm:gap-4">
						<button
							type="submit"
							className="btn btn-primary flex-1">
							{submitLabel}
						</button>
						<button
							type="button"
							onClick={onCancel}
							className="btn btn-secondary flex-1">
							{cancelLabel}
						</button>
					</div>
				</form>
			</div>
		</>
	);
}
