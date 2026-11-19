import test from "node:test";
import assert from "node:assert/strict";
import { getArchiverErrorText } from "../src/app/admin/components/archiverErrors.js";

const httpError = (status, data) => ({ response: { status, data } });

test("403 maps to the admin permission message for both actions", () =>
{
	const expected = "Brak uprawnień administratora.";

	assert.equal(getArchiverErrorText(httpError(403, { error: "Admin access required" }), "status"), expected);
	assert.equal(getArchiverErrorText(httpError(403), "start"), expected);
});

test("409 maps to the already running message and hides server text", () =>
{
	const text = getArchiverErrorText(httpError(409, { error: "Archiver is already running" }), "start");

	assert.equal(text, "Archiwizacja jest już uruchomiona.");
});

test("no response, network failure and timeouts map to the connection message", () =>
{
	const expected = "Nie udało się połączyć z serwerem. Spróbuj ponownie.";

	assert.equal(getArchiverErrorText(new TypeError("Failed to fetch"), "status"), expected);
	assert.equal(getArchiverErrorText(new DOMException("Timeout", "TimeoutError"), "status"), expected);
	assert.equal(getArchiverErrorText(new DOMException("Aborted", "AbortError"), "start"), expected);
	assert.equal(getArchiverErrorText(undefined, "start"), expected);
});

test("other responses fall back per action and never expose server text", () =>
{
	const err = httpError(500, { error: "Internal boom" });

	assert.equal(getArchiverErrorText(err, "status"), "Nie udało się pobrać statusu archiwizacji.");
	assert.equal(getArchiverErrorText(err, "start"), "Nie udało się uruchomić archiwizacji.");
});

test("unknown action is rejected", () =>
{
	assert.throws(() => getArchiverErrorText(httpError(500), "other"), TypeError);
});
