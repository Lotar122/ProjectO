"use client";

import http from "@/app/lib/http";
import { AnimatePresence, m } from "framer-motion";
import { Trash2 } from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState } from "react";

import Alert from "@/app/components/Alert";
import { DIALOG_BACKDROP, DIALOG_PANEL } from "@/app/components/motion";
import useModalA11y from "@/app/components/useModalA11y";
import { pluralPl } from "@/app/lib/pluralPl";

const ENDPOINT = "/api/admin/deleteAccountData";
const EMPTY_TOTALS = { ordersDeleted: 0, filesDeleted: 0, partiesDeleted: 0 };

const ORDERS = ["zlecenie", "zlecenia", "zleceń"];
const FILES = ["plik", "pliki", "plików"];
const PARTIES = ["zleceniodawca", "zleceniodawców", "zleceniodawców"];

const describeCounts = ({ orders, files, parties }) =>
	`${orders} ${pluralPl(orders, ORDERS)}, ${files} ${pluralPl(files, FILES)}, ${parties} ${pluralPl(parties, PARTIES)}`;

// Mounted only while the dialog is open, so every opening starts with fresh state.
function DeleteAccountDataDialog({ identity, onClose, returnFocusRef })
{
	const titleId = useId();
	const descriptionId = useId();
	const cancelRef = useRef(null);
	const [phase, setPhase] = useState("loading");
	const [preview, setPreview] = useState(null);
	const [totals, setTotals] = useState(EMPTY_TOTALS);
	const [errorMessage, setErrorMessage] = useState("");
	const isBusy = phase === "loading" || phase === "deleting";

	const close = useCallback(() =>
	{
		if (phase !== "deleting")
		{
			onClose({ deleted: phase === "done" });
		}
	}, [phase, onClose]);

	const dialogRef = useModalA11y({
		isOpen: true,
		onClose: close,
		initialFocusRef: cancelRef,
		returnFocusRef,
	});

	useEffect(() =>
	{
		const controller = new AbortController();

		const loadPreview = async () =>
		{
			try
			{
				const response = await http.get(`${ENDPOINT}?id=${encodeURIComponent(identity.id)}`, {
					withCredentials: true,
					signal: controller.signal,
				});

				if (!controller.signal.aborted)
				{
					setPreview(response.data);
					setPhase("ready");
				}
			}
			catch (error)
			{
				if (!controller.signal.aborted)
				{
					setErrorMessage(error.response?.data?.error || "Nie udało się pobrać liczby zleceń i plików.");
					setPhase("failed-preview");
				}
			}
		};

		void loadPreview();

		return () =>
		{
			controller.abort();
		};
	}, [identity.id]);

	const confirm = async () =>
	{
		setPhase("deleting");
		setErrorMessage("");

		const addToTotals = (data) =>
		{
			setTotals((current) => ({
				ordersDeleted: current.ordersDeleted + (data?.ordersDeleted ?? 0),
				filesDeleted: current.filesDeleted + (data?.filesDeleted ?? 0),
				partiesDeleted: current.partiesDeleted + (data?.partiesDeleted ?? 0),
			}));
		};

		try
		{
			const response = await http.delete(`${ENDPOINT}?id=${encodeURIComponent(identity.id)}`, {
				withCredentials: true,
			});

			addToTotals(response.data);
			setPhase("done");
		}
		catch (error)
		{
			addToTotals(error.response?.data);
			setErrorMessage(error.response?.data?.error || "Nie udało się usunąć konta wraz z danymi.");
			setPhase("ready");
		}
	};

	const hasProgress = totals.ordersDeleted + totals.filesDeleted + totals.partiesDeleted > 0;
	const totalsText = describeCounts({ orders: totals.ordersDeleted, files: totals.filesDeleted, parties: totals.partiesDeleted });

	return (
		<m.div
			{...DIALOG_BACKDROP}
			onClick={(event) =>
			{
				if (event.target === event.currentTarget)
				{
					close();
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
				className="w-full max-w-md rounded-xl border border-line bg-surface-raised p-6 shadow-overlay outline-none">
				<h2 id={titleId} className="mb-4 text-lg font-semibold text-foreground">
					Usuń konto wraz ze wszystkimi danymi
				</h2>

				<div id={descriptionId} className="mb-6 space-y-3 text-sm text-muted" aria-live="polite">
					{phase === "done" ? (
						<Alert tone="success" announce={false}>
							Konto zostało usunięte. Usunięto łącznie: {totalsText}.
						</Alert>
					) : phase === "loading" ? (
						<p>Liczenie zleceń i plików...</p>
					) : phase === "failed-preview" ? null : (
						<>
							<p className="wrap-break-word">
								Konto <span className="font-semibold text-foreground">{identity.traits?.email || "użytkownika"}</span> zostanie
								usunięte razem z danymi: <span className="font-semibold text-foreground tabular-nums">{describeCounts(preview ?? { orders: 0, files: 0, parties: 0 })}</span>.
							</p>
							<p>Tej operacji nie można cofnąć. Pliki zostaną usunięte z magazynu bez możliwości odzyskania.</p>
						</>
					)}

					{hasProgress && phase !== "done" && (
						<p>Usunięto do tej pory: <span className="tabular-nums">{totalsText}</span>.</p>
					)}
				</div>

				{errorMessage && <Alert tone="danger" className="mb-6">{errorMessage}</Alert>}

				<div className="flex justify-end gap-3">
					<button
						ref={cancelRef}
						type="button"
						onClick={close}
						disabled={phase === "deleting"}
						className="btn btn-secondary min-w-24">
						{phase === "done" ? "Zamknij" : "Anuluj"}
					</button>
					{phase !== "done" && phase !== "failed-preview" && (
						<button
							type="button"
							onClick={confirm}
							disabled={isBusy}
							className="btn btn-danger">
							<Trash2 className="h-4 w-4" aria-hidden="true" />
							{phase === "deleting" ? "Usuwanie..." : errorMessage ? "Spróbuj ponownie" : "Usuń konto i dane"}
						</button>
					)}
				</div>
			</m.div>
		</m.div>
	);
}

/**
 * Confirmation for deleting an account together with all its orders, files and
 * ordering parties. Loads the counts first, then runs the deletion; a failed run
 * can be retried and the counts of every attempt are added up for the admin.
 * `onClose({ deleted })` is called when the dialog closes; `deleted` is true once
 * the account is gone.
 */
export default function DeleteAccountDataModal({ isOpen, identity, onClose, returnFocusRef })
{
	return (
		<AnimatePresence>
			{isOpen && <DeleteAccountDataDialog identity={identity} onClose={onClose} returnFocusRef={returnFocusRef} />}
		</AnimatePresence>
	);
}
