"use client";

import http from "@/app/lib/http";
import { AnimatePresence, m } from "framer-motion";
import { Archive, Loader2, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState } from "react";

import Alert from "@/app/components/Alert";
import useModalA11y from "@/app/components/useModalA11y";
import { getArchiverErrorText } from "./archiverErrors";

const POLL_INTERVAL_MS = 3000;

const STATE_LABELS = {
	idle: "Nie uruchamiano",
	running: "W toku",
	done: "Zakończono",
	failed: "Błąd",
};

const STATE_CLASSES = {
	idle: "bg-surface-raised text-muted",
	running: "bg-accent-soft text-accent-text",
	done: "bg-success-soft text-success-text",
	failed: "bg-danger-soft text-danger-text",
};

const formatBytes = (value) =>
{
	const bytes = Number(value) || 0;
	const units = ["B", "KB", "MB", "GB", "TB"];
	let size = Math.abs(bytes);
	let unit = 0;

	while (size >= 1024 && unit < units.length - 1)
	{
		size /= 1024;
		unit++;
	}

	const text = unit === 0
		? String(Math.round(size))
		: size.toLocaleString("pl-PL", { maximumFractionDigits: 1 });

	return `${bytes < 0 ? "-" : ""}${text} ${units[unit]}`;
};

const formatTime = (value) =>
{
	if (!value)
	{
		return "brak";
	}

	const date = new Date(value);

	return Number.isNaN(date.getTime()) ? "brak" : date.toLocaleString("pl-PL");
};

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

function Stat({ label, value })
{
	return (
		<div className="rounded-lg border border-line bg-background p-4">
			<p className="text-xs uppercase tracking-[0.18em] text-muted">{label}</p>
			<p className="mt-1 text-lg font-semibold text-foreground">{value}</p>
		</div>
	);
}

export default function ArchiverPanel()
{
	const [status, setStatus] = useState(null);
	const [candidates, setCandidates] = useState(null);
	const [isLoading, setIsLoading] = useState(true);
	const [isStarting, setIsStarting] = useState(false);
	const [error, setError] = useState("");
	const [info, setInfo] = useState("");
	const [isConfirmOpen, setIsConfirmOpen] = useState(false);

	const state = status?.state ?? "idle";
	const isRunning = state === "running";

	const runningRef = useRef(false);
	const loopRef = useRef(null);
	// Bumped around every start request; a status GET sent before that is stale and must not
	// overwrite the state the start returned.
	const epochRef = useRef(0);

	const applyStatus = useCallback((nextStatus) =>
	{
		runningRef.current = nextStatus?.state === "running";
		setStatus(nextStatus);
	}, []);

	const loadStatus = useCallback(async (signal) =>
	{
		const epoch = epochRef.current;

		try
		{
			const response = await http.get("/api/admin/archiver", { withCredentials: true, signal });

			if (signal.aborted || epoch !== epochRef.current)
			{
				return;
			}

			applyStatus(response.data.status ?? null);
			setCandidates(response.data.candidates ?? null);
			setError("");
		}
		catch (err)
		{
			if (signal.aborted)
			{
				return;
			}

			setError(getArchiverErrorText(err, "status"));
		}
		finally
		{
			if (!signal.aborted)
			{
				setIsLoading(false);
			}
		}
	}, [applyStatus]);

	// One loop for the whole mount: the first load runs here too, and the next poll is
	// scheduled only after the previous request settles, so requests never overlap.
	useEffect(() =>
	{
		const controller = new AbortController();
		const { signal } = controller;
		let timer = null;
		let inFlight = false;

		const clearTimer = () =>
		{
			if (timer !== null)
			{
				clearTimeout(timer);
				timer = null;
			}
		};

		const schedule = () =>
		{
			clearTimer();

			if (signal.aborted || inFlight || !runningRef.current || document.visibilityState === "hidden")
			{
				return;
			}

			timer = setTimeout(() =>
			{
				timer = null;

				if (document.visibilityState !== "hidden")
				{
					run();
				}
			}, POLL_INTERVAL_MS);
		};

		const run = async () =>
		{
			if (inFlight || signal.aborted)
			{
				return;
			}

			clearTimer();
			inFlight = true;

			try
			{
				await loadStatus(signal);
			}
			finally
			{
				inFlight = false;
			}

			schedule();
		};

		const onVisibilityChange = () =>
		{
			if (document.visibilityState === "visible" && runningRef.current)
			{
				run();
			}
		};

		loopRef.current = { refresh: run, schedule };
		document.addEventListener("visibilitychange", onVisibilityChange);
		run();

		return () =>
		{
			controller.abort();
			clearTimer();
			document.removeEventListener("visibilitychange", onVisibilityChange);
			loopRef.current = null;
		};
	}, [loadStatus]);

	const startArchiver = async () =>
	{
		epochRef.current++;
		setIsConfirmOpen(false);
		setIsStarting(true);
		setError("");
		setInfo("");

		try
		{
			const response = await http.post("/api/admin/archiver", {}, { withCredentials: true });

			applyStatus(response.data.status ?? null);
			loopRef.current?.schedule();
		}
		catch (err)
		{
			const data = err.response?.data;

			if (err.response?.status === 409 && data?.status)
			{
				applyStatus(data.status);
				loopRef.current?.schedule();
				setInfo("Archiwizacja jest już w toku.");
			}
			else
			{
				setError(getArchiverErrorText(err, "start"));
			}
		}
		finally
		{
			epochRef.current++;
			setIsStarting(false);
		}
	};

	const total = status?.ordersTotal ?? 0;
	const done = status?.ordersDone ?? 0;
	// Failed orders are finished too, so they count towards progress.
	const processed = done + (status?.ordersFailed ?? 0);
	const percent = total > 0 ? Math.min(100, Math.round((processed / total) * 100)) : 0;
	const bytesBefore = status?.bytesBefore ?? 0;
	const saved = bytesBefore - (status?.bytesAfter ?? 0);
	const savedPercent = bytesBefore > 0 ? Math.round((saved / bytesBefore) * 100) : 0;
	const hasRun = state !== "idle";

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

				<div className="flex shrink-0 gap-2">
					<button
						type="button"
						onClick={() =>
						{
							setInfo("");
							loopRef.current?.refresh();
						}}
						className="btn btn-secondary">
						<RefreshCw className="h-4 w-4" aria-hidden="true" />
						Odśwież
					</button>
					<button
						type="button"
						onClick={() => setIsConfirmOpen(true)}
						disabled={isRunning || isLoading || isStarting}
						className="btn btn-primary">
						{isRunning || isStarting
							? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
							: <Archive className="h-4 w-4" aria-hidden="true" />}
						Uruchom archiwizację
					</button>
				</div>
			</div>

			{error && <Alert tone="danger" className="mt-4">{error}</Alert>}
			{info && <Alert tone="info" className="mt-4">{info}</Alert>}

			{isLoading ? (
				<p className="mt-6 text-sm text-muted">Ładowanie...</p>
			) : status && (
				<div className="mt-6 space-y-4">
					<div className="flex flex-wrap items-center gap-3">
						<span className={`inline-flex items-center rounded-full px-3 py-1 text-sm font-medium ${STATE_CLASSES[state] ?? STATE_CLASSES.idle}`}>
							{STATE_LABELS[state] ?? state}
						</span>
						<span className="text-sm text-muted">
							Zlecenia do archiwizacji: <span className="font-semibold text-foreground">{candidates ?? "brak danych"}</span>
						</span>
					</div>

					{isRunning && (
						<div>
							<div
								className="h-2 w-full rounded-full bg-surface-raised"
								role="progressbar"
								aria-label="Postęp archiwizacji"
								aria-valuemin={0}
								aria-valuemax={100}
								aria-valuenow={percent}>
								<div
									className="h-2 rounded-full bg-accent-text transition-[width] duration-300"
									style={{ width: `${percent}%` }}
								/>
							</div>
							<p className="mt-1 text-sm text-muted">
								{processed} / {total} zleceń ({percent}%)
							</p>
						</div>
					)}

					{hasRun && (
						<>
							<div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
								<Stat
									label="Zlecenia"
									value={`${done} / ${status.ordersFailed ?? 0}`}
								/>
								<Stat label="Pliki skompresowane" value={status.filesCompressed ?? 0} />
								<Stat label="Pliki pominięte" value={status.filesSkipped ?? 0} />
								<Stat label="Pliki z błędem" value={status.filesFailed ?? 0} />
							</div>
							<p className="text-xs text-muted">
								Zlecenia: przetworzone / z błędem.
							</p>

							<Stat
								label="Zaoszczędzone miejsce"
								value={`${formatBytes(saved)} (${savedPercent}%)`}
							/>

							<div className="grid gap-1 text-sm text-muted sm:grid-cols-2">
								<p>Rozpoczęto: <span className="text-foreground">{formatTime(status.startedAt)}</span></p>
								<p>Zakończono: <span className="text-foreground">{formatTime(status.finishedAt)}</span></p>
							</div>
						</>
					)}

					{status.lastError && (
						<div className="text-sm">
							<p className="text-danger-text">Ostatni przebieg zakończył się błędem.</p>
							<details className="mt-1 text-xs text-muted">
								<summary className="cursor-pointer">Szczegóły techniczne</summary>
								<p className="mt-1 font-mono wrap-break-word">{status.lastError}</p>
							</details>
						</div>
					)}
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
