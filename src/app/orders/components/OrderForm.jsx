"use client";

import { useEffect, useId } from "react";
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
	onOrderingPartyChange,
	onPatientChange,
	onRemoveAttachment,
	onAttachmentNameChange,
	onRemoveFile,
	onSubmit,
	orderingParties,
	orderingPartyId = "",
	patient,
	submitLabel,
	title,
})
{
	const id = useId();
	const isCreate = fileSectionMode === "create";
	const showOrderingParty = Boolean(orderingParties?.length);
	const singleOrderingPartyId = orderingParties?.length === 1 ? orderingParties[0].id : "";

	// A lone zleceniodawca is selected for the user; the field stays visible and required.
	useEffect(() =>
	{
		if (singleOrderingPartyId && !orderingPartyId)
		{
			onOrderingPartyChange?.(singleOrderingPartyId);
		}
	}, [singleOrderingPartyId, orderingPartyId, onOrderingPartyChange]);

	return (
		<div className="mx-auto max-w-2xl">
			<div className="mb-6 sm:mb-8">
				<h2 className="mb-2 text-2xl font-bold text-foreground sm:text-3xl">{title}</h2>
				<p className="text-muted">{description}</p>
			</div>

			<div className="rounded-xl border border-line bg-surface p-4 sm:p-8">
				<form onSubmit={onSubmit} className="space-y-6">
					<div>
						<label htmlFor={`${id}-patient`} className="field-label">
							Pacjent
						</label>
						<input
							id={`${id}-patient`}
							type="text"
							value={patient}
							onChange={(event) => onPatientChange(event.target.value)}
							className="field"
							placeholder="np. J.K. lub numer sprawy"
							aria-describedby={`${id}-patient-hint`}
							required
						/>
						<p id={`${id}-patient-hint`} className="mt-1.5 text-xs text-muted">
							Zalecamy wpisać inicjały lub numer sprawy zamiast pełnego imienia i nazwiska.
						</p>
					</div>

					{showOrderingParty && (
						<div>
							<label htmlFor={`${id}-orderingParty`} className="field-label">
								Zleceniodawca
							</label>
							<select
								id={`${id}-orderingParty`}
								value={orderingPartyId}
								onChange={(event) => onOrderingPartyChange?.(event.target.value)}
								className="field"
								required>
								<option value="" className="bg-surface-sunken text-foreground">
									Wybierz zleceniodawcę
								</option>
								{orderingParties.map((party) => (
									<option
										key={party.id}
										value={party.id}
										className="bg-surface-sunken text-foreground">
										{party.name}
									</option>
								))}
							</select>
						</div>
					)}

					<div>
						<label htmlFor={`${id}-details`} className="field-label">
							Szczegóły
							{!detailsRequired && <span className="font-normal text-muted"> (opcjonalne)</span>}
						</label>
						<textarea
							id={`${id}-details`}
							value={details}
							onChange={(event) => onDetailsChange(event.target.value)}
							rows={5}
							className="field resize-y"
							placeholder="np. rodzaj pracy, wymagania, uwagi"
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

					<div className="flex flex-col gap-3 sm:flex-row-reverse sm:justify-end">
						<button
							type="submit"
							className="btn btn-primary px-5">
							{submitLabel}
						</button>
						<button
							type="button"
							onClick={onCancel}
							className="btn btn-secondary px-5">
							{cancelLabel}
						</button>
					</div>
				</form>
			</div>
		</div>
	);
}
