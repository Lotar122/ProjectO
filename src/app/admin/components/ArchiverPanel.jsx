"use client";

import http from "@/app/lib/http";
import { AnimatePresence, m } from "framer-motion";
import { Archive, Loader2, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useId, useState } from "react";

const POLL_INTERVAL_MS = 3000;

const STATE_LABELS = {
	idle: "Nie uruchamiano",
	running: "W toku",
	done: "Zakończono",
	failed: "Błąd",
};

const STATE_CLASSES = {
	idle: "bg-slate-800 text-slate-300",
	running: "bg-blue-100 text-blue-800",
	done: "bg-green-100 text-green-800",
	failed: "bg-red-100 text-red-800",
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
		return "—";
	}

	const date = new Date(value);

	return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString("pl-PL");
};

function ConfirmArchiveModal({ isOpen, onCancel, onConfirm })
{
	const titleId = useId();

	return (
		<AnimatePresence>
			{isOpen && (
				<div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
					<m.div
						initial={{ opacity: 0, scale: 0.94, y: 18 }}
						animate={{ opacity: 1, scale: 1, y: 0 }}
						exit={{ opacity: 0, scale: 0.96 }}
						role="dialog"
						aria-modal="true"
						aria-labelledby={titleId}
						className="w-full max-w-sm rounded-xl bg-gray-900 p-6">
						<h2 id={titleId} className="mb-4 text-lg font-semibold text-white">
							Uruchomić archiwizację?
						</h2>
						<p className="mb-6 text-gray-400">
							Pliki zleceń starszych niż 30 dni zostaną skompresowane. Operacja może potrwać
							dłuższą chwilę i działa w tle.
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
								className="min-w-24 rounded bg-white px-4 py-2.5 font-medium text-black transition-colors hover:bg-gray-200">
								Uruchom
							</button>
						</div>
					</m.div>
				</div>
			)}
		</AnimatePresence>
	);
}

function Stat({ label, value })
{
	return (
		<div className="rounded-lg border border-slate-800 bg-slate-900 p-4">
			<p className="text-xs uppercase tracking-[0.18em] text-slate-500">{label}</p>
			<p className="mt-1 text-lg font-semibold text-white">{value}</p>
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

	const loadStatus = useCallback(async (signal) =>
	{
		try
		{
			const response = await http.get("/api/admin/archiver", { withCredentials: true, signal });

			setStatus(response.data.status ?? null);
			setCandidates(response.data.candidates ?? null);
			setError("");
		}
		catch (err)
		{
			if (signal?.aborted)
			{
				return;
			}

			setError(err.response?.data?.error || "Nie udało się pobrać statusu archiwizacji.");
		}
		finally
		{
			if (!signal?.aborted)
			{
				setIsLoading(false);
			}
		}
	}, []);

	useEffect(() =>
	{
		const controller = new AbortController();

		const loadInitialStatus = async () =>
		{
			await loadStatus(controller.signal);
		};

		loadInitialStatus();

		return () => controller.abort();
	}, [loadStatus]);

	useEffect(() =>
	{
		if (!isRunning)
		{
			return undefined;
		}

		const interval = setInterval(loadStatus, POLL_INTERVAL_MS);

		return () => clearInterval(interval);
	}, [isRunning, loadStatus]);

	const startArchiver = async () =>
	{
		setIsConfirmOpen(false);
		setIsStarting(true);
		setError("");
		setInfo("");

		try
		{
			const response = await http.post("/api/admin/archiver", {}, { withCredentials: true });

			setStatus(response.data.status ?? null);
		}
		catch (err)
		{
			const data = err.response?.data;

			if (err.response?.status === 409 && data?.status)
			{
				setStatus(data.status);
				setInfo("Archiwizacja jest już w toku.");
			}
			else
			{
				setError(data?.error || "Nie udało się uruchomić archiwizacji.");
			}
		}
		finally
		{
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
		<section className="rounded-xl border border-slate-800 bg-slate-900 p-5 sm:p-6">
			<div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-start">
				<div className="min-w-0">
					<p className="mb-2 text-xs font-semibold uppercase tracking-[0.18em] text-violet-300">
						Konserwacja
					</p>
					<h3 className="text-xl font-bold text-white">Archiwizacja zleceń</h3>
					<p className="mt-2 max-w-2xl text-sm text-slate-400">
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
							loadStatus();
						}}
						className="inline-flex min-h-10 items-center gap-2 rounded-lg border border-slate-700 px-4 text-sm text-slate-200 transition-colors hover:border-slate-500 hover:text-white">
						<RefreshCw className="h-4 w-4" />
						Odśwież
					</button>
					<button
						type="button"
						onClick={() => setIsConfirmOpen(true)}
						disabled={isRunning || isLoading || isStarting}
						className="inline-flex min-h-10 items-center gap-2 rounded-lg bg-white px-4 text-sm font-medium text-black transition-colors hover:bg-gray-200 disabled:cursor-not-allowed disabled:opacity-60">
						{isRunning || isStarting
							? <Loader2 className="h-4 w-4 animate-spin" />
							: <Archive className="h-4 w-4" />}
						Uruchom archiwizację
					</button>
				</div>
			</div>

			{error && (
				<p className="mt-4 rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300">
					{error}
				</p>
			)}
			{info && (
				<p className="mt-4 rounded-lg border border-sky-500/30 bg-sky-500/10 px-4 py-3 text-sm text-sky-300">
					{info}
				</p>
			)}

			{isLoading ? (
				<p className="mt-6 text-sm text-slate-400">Ładowanie...</p>
			) : status && (
				<div className="mt-6 space-y-4">
					<div className="flex flex-wrap items-center gap-3">
						<span className={`inline-flex items-center rounded-full px-3 py-1 text-sm font-medium ${STATE_CLASSES[state] ?? STATE_CLASSES.idle}`}>
							{STATE_LABELS[state] ?? state}
						</span>
						<span className="text-sm text-slate-400">
							Zlecenia do archiwizacji: <span className="font-semibold text-white">{candidates ?? "—"}</span>
						</span>
					</div>

					{isRunning && (
						<div>
							<div className="h-2 w-full rounded-full bg-slate-700">
								<div
									className="h-2 rounded-full bg-blue-500 transition-[width] duration-300"
									style={{ width: `${percent}%` }}
								/>
							</div>
							<p className="mt-1 text-sm text-slate-500">
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
							<p className="text-xs text-slate-500">
								Zlecenia: przetworzone / z błędem.
							</p>

							<Stat
								label="Zaoszczędzone miejsce"
								value={`${formatBytes(saved)} (${savedPercent}%)`}
							/>

							<div className="grid gap-1 text-sm text-slate-400 sm:grid-cols-2">
								<p>Rozpoczęto: <span className="text-slate-300">{formatTime(status.startedAt)}</span></p>
								<p>Zakończono: <span className="text-slate-300">{formatTime(status.finishedAt)}</span></p>
							</div>
						</>
					)}

					{status.lastError && (
						<p className="text-sm text-red-400 wrap-break-word">
							Ostatni błąd: {status.lastError}
						</p>
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
