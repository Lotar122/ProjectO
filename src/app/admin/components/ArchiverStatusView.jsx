import {
	CircleAlert,
	CircleCheck,
	CircleDashed,
	Clock,
	FolderSearch,
	Info,
	Loader2,
	OctagonX,
	Server,
	ServerOff,
	TriangleAlert,
} from "lucide-react";

import {
	describeCurrentFile,
	getNeedsAttentionText,
	getStateLabel,
	getStateNotice,
} from "./archiverPanelCopy.js";

const STATE_STYLES = {
	idle: { classes: "bg-surface-raised text-muted", icon: CircleDashed },
	queued: { classes: "bg-accent-soft text-accent-text", icon: Clock },
	running: { classes: "bg-accent-soft text-accent-text", icon: Loader2, spin: true },
	stalled: { classes: "bg-warning-soft text-warning-text", icon: TriangleAlert },
	done: { classes: "bg-success-soft text-success-text", icon: CircleCheck },
	failed: { classes: "bg-danger-soft text-danger-text", icon: CircleAlert },
	interrupted: { classes: "bg-warning-soft text-warning-text", icon: OctagonX },
};

const NOTICE_STYLES = {
	info: { classes: "border-accent-line bg-accent-soft text-accent-text", icon: Info },
	warning: { classes: "border-warning-line bg-warning-soft text-warning-text", icon: TriangleAlert },
	danger: { classes: "border-danger-line bg-danger-soft text-danger-text", icon: CircleAlert },
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

function Stat({ label, value })
{
	return (
		<div className="rounded-lg border border-line bg-background p-4">
			<p className="text-xs uppercase tracking-[0.18em] text-muted">{label}</p>
			<p className="mt-1 text-lg font-semibold tabular-nums text-foreground">{value}</p>
		</div>
	);
}

function Notice({ tone, icon, role, children })
{
	const { classes, icon: ToneIcon } = NOTICE_STYLES[tone];
	const Icon = icon ?? ToneIcon;

	return (
		<div role={role} className={`flex items-start gap-3 rounded-lg border px-4 py-3 text-sm ${classes}`}>
			<Icon className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
			<div className="min-w-0 wrap-break-word">{children}</div>
		</div>
	);
}

function ProgressBar({ label, valueText, percent, tone, children })
{
	return (
		<div>
			{children}
			<div
				className="mt-1 h-2 w-full rounded-full bg-surface-raised"
				role="progressbar"
				aria-label={label}
				aria-valuemin={0}
				aria-valuemax={100}
				aria-valuenow={percent}
				aria-valuetext={valueText}>
				<div
					className={`h-2 rounded-full transition-[width] duration-300 ${tone === "warning" ? "bg-warning-text" : "bg-accent-text"}`}
					style={{ width: `${percent}%` }}
				/>
			</div>
		</div>
	);
}

function WorkerLine({ worker, id })
{
	const online = worker?.online === true;
	const Icon = online ? Server : ServerOff;

	return (
		<p id={id} className={`flex items-center gap-2 text-sm ${online ? "text-muted" : "text-warning-text"}`}>
			<Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
			<span>
				Proces archiwizacji:{" "}
				<span className="font-semibold">{online ? "dostępny" : "niedostępny"}</span>
				<span className="text-muted">
					{" "}
					(ostatni sygnał: {formatTime(worker?.heartbeatAt)})
				</span>
			</span>
		</p>
	);
}

/**
 * Read-only view of one archiver status response. Holds no state and does no requests,
 * so every state the API can return renders from props alone.
 * @param {{ status: object, candidates: number | null, worker: { online?: boolean, heartbeatAt?: string | null } | null, needsAttention: number, workerLineId?: string }} props
 * `workerLineId` is the id given to the worker line, so a disabled button can point at it.
 */
export default function ArchiverStatusView({ status, candidates, worker, needsAttention, workerLineId })
{
	const state = status?.state ?? "idle";
	const stateStyle = STATE_STYLES[state] ?? STATE_STYLES.idle;
	const StateIcon = stateStyle.icon;
	const isInProgress = state === "running" || state === "stalled";
	const hasRun = state !== "idle" && state !== "queued";
	const notice = getStateNotice(state, worker?.online === true);

	const total = status?.ordersTotal ?? 0;
	const done = status?.ordersDone ?? 0;
	// Failed orders are finished too, so they count towards progress.
	const processed = done + (status?.ordersFailed ?? 0);
	const percent = total > 0 ? Math.min(100, Math.round((processed / total) * 100)) : 0;
	const bytesBefore = status?.bytesBefore ?? 0;
	const saved = bytesBefore - (status?.bytesAfter ?? 0);
	const savedPercent = bytesBefore > 0 ? Math.round((saved / bytesBefore) * 100) : 0;
	const file = isInProgress ? describeCurrentFile(status?.currentFile) : null;
	const barTone = state === "stalled" ? "warning" : "accent";

	return (
		<div className="space-y-4">
			<div role="status" aria-live="polite" className="space-y-4">
				<div className="flex flex-wrap items-center gap-x-4 gap-y-2">
					<span
						className={`inline-flex items-center gap-2 rounded-full px-3 py-1 text-sm font-medium ${stateStyle.classes}`}>
						<StateIcon
							className={`h-4 w-4 ${stateStyle.spin ? "animate-spin" : ""}`}
							aria-hidden="true"
						/>
						{getStateLabel(state)}
					</span>
					<span className="text-sm text-muted">
						Zlecenia do archiwizacji:{" "}
						<span className="font-semibold tabular-nums text-foreground">{candidates ?? "brak danych"}</span>
					</span>
				</div>

				{notice && (
					<Notice tone={notice.tone}>
						<p>{notice.text}</p>
						{notice.detail && <p className="mt-1">{notice.detail}</p>}
					</Notice>
				)}
			</div>

			<WorkerLine worker={worker} id={workerLineId} />

			{needsAttention > 0 && (
				<Notice tone="warning" icon={FolderSearch} role="alert">
					<p>{getNeedsAttentionText(needsAttention)}</p>
				</Notice>
			)}

			{isInProgress && (
				<div className="space-y-4">
					<ProgressBar
						label="Postęp archiwizacji"
						valueText={`${processed} z ${total} zleceń, ${percent}%`}
						percent={percent}
						tone={barTone}>
						<p className="text-sm text-muted">
							Zlecenia: <span className="tabular-nums text-foreground">{processed} / {total}</span>
							{" "}
							<span className="tabular-nums">({percent}%)</span>
						</p>
					</ProgressBar>

					{file && file.percent !== null && (
						<ProgressBar
							label="Postęp bieżącego pliku"
							valueText={`${file.label}, ${file.percent}%`}
							percent={file.percent}
							tone={barTone}>
							<p className="flex flex-wrap justify-between gap-x-4 text-sm text-muted">
								<span className="text-foreground">{file.label}</span>
								<span className="tabular-nums">
									{formatBytes(file.bytesDone)} / {formatBytes(file.bytesTotal)} ({file.percent}%)
								</span>
							</p>
						</ProgressBar>
					)}

					{file && file.percent === null && (
						<p className="text-sm text-muted">
							Bieżący plik: <span className="text-foreground">{file.label}</span>
						</p>
					)}
				</div>
			)}

			{hasRun && (
				<>
					<div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
						<Stat label="Zlecenia" value={`${done} / ${status.ordersFailed ?? 0}`} />
						<Stat label="Pliki skompresowane" value={status.filesCompressed ?? 0} />
						<Stat label="Pliki pominięte" value={status.filesSkipped ?? 0} />
						<Stat label="Pliki z błędem" value={status.filesFailed ?? 0} />
					</div>
					<p className="text-xs text-muted">Zlecenia: przetworzone / z błędem.</p>

					<Stat label="Zaoszczędzone miejsce" value={`${formatBytes(saved)} (${savedPercent}%)`} />

					<div className="grid gap-1 text-sm text-muted sm:grid-cols-2">
						<p>Rozpoczęto: <span className="text-foreground">{formatTime(status.startedAt)}</span></p>
						<p>Zakończono: <span className="text-foreground">{formatTime(status.finishedAt)}</span></p>
					</div>
				</>
			)}
		</div>
	);
}
