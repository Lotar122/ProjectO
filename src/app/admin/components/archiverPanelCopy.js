import { getArchiverErrorText } from "./archiverErrors.js";

// Job states the API can return. Queued, running and stalled mean a job is still owned
// by the queue: the panel polls and blocks a new start while one of them is shown.
const ACTIVE_STATES = new Set(["queued", "running", "stalled"]);

const STATE_LABELS = {
	idle: "Nie uruchamiano",
	queued: "W kolejce",
	running: "W toku",
	stalled: "Brak odpowiedzi",
	done: "Zakończono",
	failed: "Błąd",
	interrupted: "Przerwano",
};

const UNKNOWN_STATE_LABEL = "Nieznany stan";

// The worker reports either the pipeline step or the codec it is running.
const PHASE_LABELS = {
	download: "Pobieranie pliku",
	"compress-zstd": "Kompresja zstd",
	zstd: "Kompresja zstd",
	"compress-br": "Kompresja brotli",
	br: "Kompresja brotli",
	verify: "Weryfikacja wyniku",
	upload: "Wysyłanie wyniku",
	readback: "Odczyt kontrolny",
};

const UNKNOWN_PHASE_LABEL = "Przetwarzanie pliku";

const CODE_MESSAGES = {
	ARCHIVER_BUSY: "Archiwizacja już trwa.",
	ARCHIVER_WORKER_OFFLINE: "Proces archiwizacji jest niedostępny. Spróbuj ponownie później.",
};

export const RECOVERY_DIRECTORY = "/work/recovery";

/**
 * @param {unknown} state Job state from the status API.
 * @returns {boolean} True while a job is queued, running or stalled.
 */
export function isActiveState(state)
{
	return typeof state === "string" && ACTIVE_STATES.has(state);
}

/**
 * @param {unknown} state Job state from the status API.
 * @returns {string} Polish label, a neutral one for a state this panel does not know.
 */
export function getStateLabel(state)
{
	return typeof state === "string" && Object.hasOwn(STATE_LABELS, state)
		? STATE_LABELS[state]
		: UNKNOWN_STATE_LABEL;
}

/**
 * @param {unknown} phase `currentFile.phase` from the status API.
 * @returns {string} Polish label, a neutral one for a phase this panel does not know.
 */
export function getPhaseLabel(phase)
{
	return typeof phase === "string" && Object.hasOwn(PHASE_LABELS, phase)
		? PHASE_LABELS[phase]
		: UNKNOWN_PHASE_LABEL;
}

/**
 * @param {{ phase?: unknown, bytesDone?: unknown, bytesTotal?: unknown } | null | undefined} currentFile
 * @returns {{ label: string, bytesDone: number, bytesTotal: number, percent: number | null } | null}
 * `percent` is null when the total is unknown, so the UI can skip the bar instead of showing 0%.
 */
export function describeCurrentFile(currentFile)
{
	if (!currentFile || typeof currentFile !== "object")
	{
		return null;
	}

	const bytesDone = Math.max(0, Number(currentFile.bytesDone) || 0);
	const bytesTotal = Math.max(0, Number(currentFile.bytesTotal) || 0);
	const percent = bytesTotal > 0
		? Math.max(0, Math.min(100, Math.round((bytesDone / bytesTotal) * 100)))
		: null;

	return { label: getPhaseLabel(currentFile.phase), bytesDone, bytesTotal, percent };
}

/**
 * Copy for the job state that needs an explanation next to the badge.
 * The server's `lastError` is English and may hold a file id, so it is never used here.
 * @param {unknown} state Job state from the status API.
 * @param {boolean} workerOnline Whether the worker sent a heartbeat recently.
 * @returns {{ tone: "info" | "warning" | "danger", text: string, detail?: string } | null}
 */
export function getStateNotice(state, workerOnline)
{
	switch (state)
	{
		case "queued":
			return workerOnline
				? { tone: "info", text: "Zadanie czeka w kolejce na rozpoczęcie przez proces archiwizacji." }
				: {
					tone: "warning",
					text: "Zadanie czeka w kolejce, ale proces archiwizacji jest niedostępny.",
					detail: "Rozpocznie się, gdy proces wróci.",
				};
		case "stalled":
			return {
				tone: "warning",
				text: "Brak odpowiedzi procesu archiwizacji.",
				detail: "Zadanie mogło się zawiesić. Po restarcie procesu zostanie oznaczone jako przerwane.",
			};
		case "interrupted":
			return {
				tone: "warning",
				text: "Przerwano (restart procesu).",
				detail: "Uruchom archiwizację ponownie. Pliki już zarchiwizowane zostaną pominięte.",
			};
		case "failed":
			return {
				tone: "danger",
				text: "Ostatni przebieg zakończył się błędem.",
				detail: "Szczegóły są w logach procesu archiwizacji.",
			};
		default:
			return null;
	}
}

/**
 * @param {number} count Number of journal entries that need a person.
 * @returns {string} Polish warning that points at the worker's recovery directory.
 */
export function getNeedsAttentionText(count)
{
	const lastTwo = count % 100;
	const last = count % 10;
	let noun = "plików";

	if (count === 1)
	{
		noun = "plik";
	}
	else if (last >= 2 && last <= 4 && !(lastTwo >= 12 && lastTwo <= 14))
	{
		noun = "pliki";
	}

	return `Do ręcznego sprawdzenia: ${count} ${noun}. Sprawdź katalog odzyskiwania procesu archiwizacji (ARCHIVER_RECOVERY_DIR, domyślnie ${RECOVERY_DIRECTORY} w kontenerze). Te wpisy nie są przetwarzane automatycznie.`;
}

/**
 * Maps a failed start request to Polish text. The API `code` wins over the HTTP status,
 * and the server's own message is never shown.
 * @param {unknown} err Error thrown by the http wrapper.
 * @returns {{ code: string | null, text: string }}
 */
export function describeStartError(err)
{
	const code = err?.response?.data?.code;

	if (typeof code === "string" && Object.hasOwn(CODE_MESSAGES, code))
	{
		return { code, text: CODE_MESSAGES[code] };
	}

	return { code: null, text: getArchiverErrorText(err, "start") };
}
