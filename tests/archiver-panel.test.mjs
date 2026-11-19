import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
	describeCurrentFile,
	describeStartError,
	getNeedsAttentionText,
	getPhaseLabel,
	getStateLabel,
	isActiveState,
} from "../src/app/admin/components/archiverPanelCopy.js";

const baseStatus = {
	state: "idle",
	startedAt: null,
	finishedAt: null,
	triggeredBy: null,
	ordersTotal: 10,
	ordersDone: 4,
	ordersFailed: 1,
	filesCompressed: 7,
	filesSkipped: 2,
	filesFailed: 1,
	bytesBefore: 1000,
	bytesAfter: 400,
	lastError: null,
	currentFile: null,
};
const onlineWorker = { online: true, version: "abc1234", heartbeatAt: "2026-11-19T10:00:00.000Z" };
const offlineWorker = { online: false, version: "abc1234", heartbeatAt: "2026-11-19T09:00:00.000Z" };

const renderScript = fileURLToPath(new URL("./helpers/renderArchiverView.mjs", import.meta.url));
const STATES = ["idle", "queued", "running", "stalled", "done", "failed", "interrupted", "weird"];

const makeCase = (status, extra = {}) => ({
	candidates: 12,
	worker: onlineWorker,
	needsAttention: 0,
	workerLineId: "worker-line",
	...extra,
	status: { ...baseStatus, ...status },
});

const runningFile = { phase: "compress-zstd", bytesDone: 1048576, bytesTotal: 4194304 };

const cases = {
	idle: makeCase({}),
	idleOffline: makeCase({}, { worker: offlineWorker }),
	idleNoHeartbeat: makeCase({}, { worker: { online: false, heartbeatAt: null } }),
	idleNoWorker: makeCase({}, { worker: null }),
	idleAttention: makeCase({}, { needsAttention: 2 }),
	queued: makeCase({ state: "queued" }),
	queuedOffline: makeCase({ state: "queued" }, { worker: offlineWorker }),
	running: makeCase({ state: "running", startedAt: "2026-11-19T09:30:00.000Z", currentFile: runningFile }),
	runningUnknownPhase: makeCase({ state: "running", currentFile: { phase: "rehash", bytesDone: 0, bytesTotal: 0 } }),
	runningNoFile: makeCase({ state: "running", currentFile: null }),
	stalled: makeCase({ state: "stalled", currentFile: { phase: "upload", bytesDone: 10, bytesTotal: 20 } }),
	interrupted: makeCase({ state: "interrupted", lastError: "Worker stopped during the job" }),
	failed: makeCase({ state: "failed", lastError: "ENOSPC: no space left for file 3f0c" }),
	done: makeCase({
		state: "done",
		startedAt: "2026-11-19T09:30:00.000Z",
		finishedAt: "2026-11-19T09:45:00.000Z",
	}),
};

for (const state of STATES)
{
	cases[`english-${state}`] = makeCase({
		state,
		lastError: "Worker stopped during the job",
		currentFile: { phase: "compress-br", bytesDone: 1, bytesTotal: 2 },
	}, { needsAttention: 1 });
}

// One child process renders every case: spawning per test is slow.
const rendered = (() =>
{
	const result = spawnSync(process.execPath, [renderScript, JSON.stringify(cases)], {
		encoding: "utf8",
		timeout: 15000,
	});

	assert.equal(result.status, 0, `render helper failed: ${result.error?.message ?? ""} ${result.stderr}`);

	return JSON.parse(result.stdout);
})();

const render = (name) => rendered[name];

const httpError = (status, data) => ({ response: { status, data } });

test("queued, running and stalled are the active states", () =>
{
	for (const state of ["queued", "running", "stalled"])
	{
		assert.equal(isActiveState(state), true, state);
	}

	for (const state of ["idle", "done", "failed", "interrupted", undefined, null, "other"])
	{
		assert.equal(isActiveState(state), false, String(state));
	}
});

test("every API state has Polish copy and an unknown one a neutral label", () =>
{
	const labels = ["idle", "queued", "running", "stalled", "done", "failed", "interrupted"].map(getStateLabel);

	assert.deepEqual(labels, [
		"Nie uruchamiano", "W kolejce", "W toku", "Brak odpowiedzi", "Zakończono", "Błąd", "Przerwano",
	]);
	assert.equal(getStateLabel("exploded"), "Nieznany stan");
});

test("every worker phase maps to a Polish label with a neutral fallback", () =>
{
	for (const phase of ["download", "compress-zstd", "compress-br", "zstd", "br", "verify", "upload", "readback"])
	{
		assert.notEqual(getPhaseLabel(phase), "Przetwarzanie pliku", phase);
		assert.doesNotMatch(getPhaseLabel(phase), /compress|download|readback/i, phase);
	}

	assert.equal(getPhaseLabel("rehash"), "Przetwarzanie pliku");
	assert.equal(getPhaseLabel(null), "Przetwarzanie pliku");
	assert.equal(getPhaseLabel("constructor"), "Przetwarzanie pliku");
});

test("describeCurrentFile clamps progress and skips the bar when the total is unknown", () =>
{
	assert.equal(describeCurrentFile(null), null);
	assert.equal(describeCurrentFile({ phase: "zstd", bytesDone: 50, bytesTotal: 200 }).percent, 25);
	assert.equal(describeCurrentFile({ phase: "zstd", bytesDone: 500, bytesTotal: 200 }).percent, 100);
	assert.equal(describeCurrentFile({ phase: "zstd", bytesDone: 5, bytesTotal: 0 }).percent, null);
	assert.equal(describeCurrentFile({ phase: null, bytesDone: "x", bytesTotal: "y" }).percent, null);
});

test("start errors map by API code, then fall back without server text", () =>
{
	assert.deepEqual(
		describeStartError(httpError(409, { code: "ARCHIVER_BUSY", error: "Archiver is already running" })),
		{ code: "ARCHIVER_BUSY", text: "Archiwizacja już trwa." },
	);
	assert.deepEqual(
		describeStartError(httpError(503, { code: "ARCHIVER_WORKER_OFFLINE", error: "Archiver worker is offline" })),
		{ code: "ARCHIVER_WORKER_OFFLINE", text: "Proces archiwizacji jest niedostępny. Spróbuj ponownie później." },
	);
	assert.equal(describeStartError(httpError(500, { error: "Internal boom" })).text, "Nie udało się uruchomić archiwizacji.");
	assert.equal(describeStartError(httpError(503, { code: "SOMETHING_NEW", error: "English" })).code, null);
	assert.equal(describeStartError(new TypeError("Failed to fetch")).text, "Nie udało się połączyć z serwerem. Spróbuj ponownie.");
});

test("needs attention text uses the right Polish plural and names the recovery directory", () =>
{
	assert.match(getNeedsAttentionText(1), /1 plik\./);
	assert.match(getNeedsAttentionText(3), /3 pliki\./);
	assert.match(getNeedsAttentionText(5), /5 plików\./);
	assert.match(getNeedsAttentionText(12), /12 plików\./);
	assert.match(getNeedsAttentionText(22), /22 pliki\./);
	assert.match(getNeedsAttentionText(2), /ARCHIVER_RECOVERY_DIR, domyślnie \/work\/recovery/);
});

test("idle: badge, candidates and worker line, no stats", () =>
{
	const html = render("idle");

	assert.match(html, /Nie uruchamiano/);
	assert.match(html, /Zlecenia do archiwizacji:/);
	assert.match(html, /font-semibold">dostępny</);
	assert.doesNotMatch(html, /Pliki skompresowane/);
	assert.doesNotMatch(html, /role="progressbar"/);
});

test("queued: waits for the worker, no stats and no progress", () =>
{
	const html = render("queued");

	assert.match(html, /W kolejce/);
	assert.match(html, /czeka w kolejce na rozpoczęcie/);
	assert.doesNotMatch(html, /Pliki skompresowane/);
	assert.doesNotMatch(html, /role="progressbar"/);
	assert.match(render("queuedOffline"), /proces archiwizacji jest niedostępny/);
});

test("running: both progress bars with the Polish phase and sizes", () =>
{
	const html = render("running");

	assert.match(html, /W toku/);
	assert.match(html, /aria-label="Postęp archiwizacji"[^>]*aria-valuenow="50"/);
	assert.match(html, /aria-label="Postęp bieżącego pliku"[^>]*aria-valuenow="25"/);
	assert.match(html, /Kompresja zstd/);
	assert.match(html, /1 MB \/ 4 MB \(25%\)/);
	assert.match(html, /Pliki skompresowane/);
});

test("running with an unknown phase and total shows the neutral label and no file bar", () =>
{
	const html = render("runningUnknownPhase");

	assert.match(html, /Bieżący plik:/);
	assert.match(html, /Przetwarzanie pliku/);
	assert.doesNotMatch(html, /Postęp bieżącego pliku/);
	assert.doesNotMatch(render("runningNoFile"), /Bieżący plik/);
});

test("stalled: warning with the no-response copy while keeping the last progress", () =>
{
	const html = render("stalled");

	assert.match(html, /Brak odpowiedzi procesu archiwizacji\./);
	assert.match(html, /Wysyłanie wyniku/);
	assert.match(html, /bg-warning-text/);
});

test("interrupted: restart copy and a hint to start again", () =>
{
	const html = render("interrupted");

	assert.match(html, /Przerwano \(restart procesu\)\./);
	assert.match(html, /Uruchom archiwizację ponownie/);
	assert.doesNotMatch(html, /Worker stopped/);
});

test("failed: Polish message only, server lastError never rendered", () =>
{
	const html = render("failed");

	assert.match(html, /Ostatni przebieg zakończył się błędem\./);
	assert.doesNotMatch(html, /ENOSPC|3f0c/);
});

test("done: stats and saved space, no progress bars", () =>
{
	const html = render("done");

	assert.match(html, /Zakończono/);
	assert.match(html, /Zaoszczędzone miejsce/);
	assert.match(html, /600 B \(60%\)/);
	assert.doesNotMatch(html, /role="progressbar"/);
});

test("worker line tells online from offline and shows the heartbeat; missing data counts as offline", () =>
{
	assert.match(render("idle"), /font-semibold">dostępny</);
	assert.doesNotMatch(render("idle"), /niedostępny</);

	const offline = render("idleOffline");

	assert.match(offline, /font-semibold">niedostępny</);
	assert.doesNotMatch(offline, /font-semibold">dostępny</);
	assert.match(offline, /ostatni sygnał: (?!brak)/);
	assert.match(render("idleNoHeartbeat"), /ostatni sygnał: brak/);
	assert.match(render("idleNoWorker"), /font-semibold">niedostępny</);
});

test("the worker line carries the id a disabled button points at", () =>
{
	assert.match(render("idleOffline"), /<p id="worker-line"/);
});

test("needsAttention warning appears only when there are entries and is an alert", () =>
{
	assert.doesNotMatch(render("idle"), /ARCHIVER_RECOVERY_DIR/);

	const html = render("idleAttention");

	assert.match(html, /role="alert"/);
	assert.match(html, /Do ręcznego sprawdzenia: 2 pliki\..*ARCHIVER_RECOVERY_DIR, domyślnie \/work\/recovery/);
});

test("badge and state notices sit in one polite live region, the progress bars do not", () =>
{
	const html = render("running");
	const live = html.match(/<div role="status" aria-live="polite"[^>]*>/g) ?? [];

	assert.equal(live.length, 1);
	assert.ok(html.indexOf("W toku") > html.indexOf('role="status"'));
	assert.doesNotMatch(html, /role="progressbar"[^>]*aria-live/);
	assert.doesNotMatch(html, /opacity-90/);
	assert.match(render("stalled").slice(render("stalled").indexOf('role="status"')), /Brak odpowiedzi procesu archiwizacji/);
});

test("no state renders English server text or emoji", () =>
{
	const english = /\b(running|queued|stalled|interrupted|failed|worker|download|compress|readback|offline)\b/i;
	const emoji = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}]/u;

	for (const state of STATES)
	{
		const html = render(`english-${state}`);
		const text = html.replace(/<[^>]*>/g, " ");

		assert.doesNotMatch(text, english, state);
		assert.doesNotMatch(html, emoji, state);
	}
});
