"use client";

import http from "@/app/lib/http";
import { AnimatePresence, m } from "framer-motion";
import { Archive, Loader2, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState } from "react";

import Alert from "@/app/components/Alert";
import useModalA11y from "@/app/components/useModalA11y";
import { getArchiverErrorText } from "./archiverErrors";
import { describeStartError, isActiveState } from "./archiverPanelCopy";
import { createStatusPoller } from "./archiverPolling";
import ArchiverStatusView from "./ArchiverStatusView";

function ConfirmArchiveModal({ isOpen, onCancel, onConfirm })
{
	const titleId = useId();
	const cancelRef = useRef(null);
	const dialogRef = useModalA11y({ isOpen, onClose: onCancel, initialFocusRef: cancelRef });

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
							Uruchomić archiwizację?
						</h2>
						<p className="mb-6 text-muted">
							Pliki zleceń starszych niż 30 dni zostaną skompresowane. Operacja może potrwać
							dłuższą chwilę i działa w tle.
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
								className="btn btn-primary min-w-24">
								Uruchom
							</button>
						</div>
					</m.div>
				</m.div>
			)}
		</AnimatePresence>
	);
}

export default function ArchiverPanel()
{
	const [status, setStatus] = useState(null);
	const [candidates, setCandidates] = useState(null);
	const [worker, setWorker] = useState(null);
	const [needsAttention, setNeedsAttention] = useState(0);
	const [isLoading, setIsLoading] = useState(true);
	const [isStarting, setIsStarting] = useState(false);
	const [error, setError] = useState("");
	const [info, setInfo] = useState("");
	const [isConfirmOpen, setIsConfirmOpen] = useState(false);

	const isActive = isActiveState(status?.state);
	const isWorkerOnline = worker?.online === true;
	// The worker line only exists once a status has loaded, so the hint waits for it too.
	const showWorkerHint = !isLoading && Boolean(status) && !isWorkerOnline && !isActive;

	// Mirrors isActive for the polling loop, which must not depend on render timing.
	const activeRef = useRef(false);
	const pollerRef = useRef(null);
	const workerLineId = useId();

	const applyStatus = useCallback((nextStatus) =>
	{
		activeRef.current = isActiveState(nextStatus?.state);
		setStatus(nextStatus);
	}, []);

	// One loop for the whole mount; its first request is the initial load. It polls every
	// 3 s while a job is active and every 20 s otherwise, so a worker that comes back
	// re-enables the start button.
	useEffect(() =>
	{
		const controller = new AbortController();

		pollerRef.current = createStatusPoller({
			fetchStatus: async (signal) =>
			{
				const response = await http.get("/api/admin/archiver", { withCredentials: true, signal });

				return response.data;
			},
			onData: (data) =>
			{
				applyStatus(data.status ?? null);
				setCandidates(data.candidates ?? null);
				setWorker(data.worker ?? null);
				setNeedsAttention(Number(data.needsAttention) || 0);
				setError("");
			},
			onError: (err) => setError(getArchiverErrorText(err, "status")),
			onSettled: () => setIsLoading(false),
			isActive: () => activeRef.current,
			signal: controller.signal,
			visibility: {
				isHidden: () => document.visibilityState === "hidden",
				subscribe: (listener) =>
				{
					document.addEventListener("visibilitychange", listener);

					return () => document.removeEventListener("visibilitychange", listener);
				},
			},
			timers: {
				set: (callback, ms) => setTimeout(callback, ms),
				clear: (handle) => clearTimeout(handle),
			},
		});

		return () =>
		{
			controller.abort();
			pollerRef.current = null;
		};
	}, [applyStatus]);

	const startArchiver = async () =>
	{
		// The status the start returned can be missing (the read after enqueue failed),
		// so the panel then asks for a fresh one.
		let needsRefresh = false;

		pollerRef.current?.beginMutation();
		setIsConfirmOpen(false);
		setIsStarting(true);
		setError("");
		setInfo("");

		try
		{
			const response = await http.post("/api/admin/archiver", {}, { withCredentials: true });

			if (response.data.status)
			{
				applyStatus(response.data.status);
				pollerRef.current?.schedule();
			}
			else
			{
				needsRefresh = true;
			}
		}
		catch (err)
		{
			const { code, text } = describeStartError(err);

			if (code === "ARCHIVER_BUSY")
			{
				const busyStatus = err.response?.data?.status;

				if (busyStatus)
				{
					applyStatus(busyStatus);
					pollerRef.current?.schedule();
				}
				else
				{
					needsRefresh = true;
				}

				setInfo(text);
			}
			else
			{
				// No refresh here: a successful GET would clear this message.
				if (code === "ARCHIVER_WORKER_OFFLINE")
				{
					setWorker((current) => ({ ...current, online: false }));
				}

				setError(text);
			}
		}
		finally
		{
			pollerRef.current?.endMutation();
			setIsStarting(false);
		}

		if (needsRefresh)
		{
			pollerRef.current?.refresh();
		}
	};

	return (
		<section className="rounded-xl border border-line bg-surface p-5 sm:p-6">
			<div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-start">
				<div className="min-w-0">
					<p className="mb-2 text-xs font-semibold uppercase tracking-[0.18em] text-accent-text">
						Konserwacja
					</p>
					<h3 className="text-xl font-bold text-foreground">Archiwizacja zleceń</h3>
					<p className="mt-2 max-w-2xl text-sm text-muted">
						Pliki zleceń starszych niż 30 dni są kompresowane bezstratnie (zstd / brotli, wybierany
						jest lepszy wynik), aby oszczędzać miejsce na dysku. Pobieranie rozpakowuje pliki
						automatycznie, ale może potrwać dłużej.
					</p>
				</div>

				<div className="flex shrink-0 flex-col gap-2 sm:items-end">
					<div className="flex gap-2">
						<button
							type="button"
							onClick={() =>
							{
								setInfo("");
								pollerRef.current?.refresh();
							}}
							disabled={isStarting}
							className="btn btn-secondary">
							<RefreshCw className="h-4 w-4" aria-hidden="true" />
							Odśwież
						</button>
						<button
							type="button"
							onClick={() => setIsConfirmOpen(true)}
							disabled={isActive || isLoading || isStarting || !isWorkerOnline}
							aria-describedby={showWorkerHint ? workerLineId : undefined}
							className="btn btn-primary">
							{isActive || isStarting
								? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
								: <Archive className="h-4 w-4" aria-hidden="true" />}
							Uruchom archiwizację
						</button>
					</div>
					{showWorkerHint && (
						<p className="text-sm text-warning-text">Proces archiwizacji jest niedostępny</p>
					)}
				</div>
			</div>

			{error && <Alert tone="danger" className="mt-4">{error}</Alert>}
			{info && <Alert tone="info" className="mt-4">{info}</Alert>}

			{isLoading ? (
				<p className="mt-6 text-sm text-muted">Ładowanie...</p>
			) : status && (
				<div className="mt-6">
					<ArchiverStatusView
						status={status}
						candidates={candidates}
						worker={worker}
						needsAttention={needsAttention}
						workerLineId={workerLineId}
					/>
				</div>
			)}

			<ConfirmArchiveModal
				isOpen={isConfirmOpen}
				onCancel={() => setIsConfirmOpen(false)}
				onConfirm={startArchiver}
			/>
		</section>
	);
}
