import test from "node:test";
import assert from "node:assert/strict";
import {
	OWNER_EDITABLE_STATUSES,
	escapeLikePattern,
	isOwnerEditableStatus,
	isUuid,
	normalizeStatus,
	parseDateInput,
	readText,
} from "../src/app/lib/validate.js";

test("isUuid accepts uuid v7 and rejects other input", () =>
{
	assert.equal(isUuid("0190b2a4-7c3e-7d2a-9f1b-3a5c6d7e8f90"), true);
	assert.equal(isUuid("not-a-uuid"), false);
	assert.equal(isUuid(""), false);
	assert.equal(isUuid(null), false);
	assert.equal(isUuid("0190b2a4-7c3e-7d2a-9f1b-3a5c6d7e8f90' OR 1=1"), false);
});

test("normalizeStatus lowercases and dashes", () =>
{
	assert.equal(normalizeStatus(" In Progress "), "in-progress");
	assert.equal(normalizeStatus(null), "");
});

test("parseDateInput returns ISO date, null for empty, undefined for invalid", () =>
{
	assert.equal(parseDateInput("2026-10-19"), "2026-10-19");
	assert.equal(parseDateInput("2026-10-19T12:30:00.000Z"), "2026-10-19");
	assert.equal(parseDateInput(""), null);
	assert.equal(parseDateInput(null), null);
	assert.equal(parseDateInput("garbage"), undefined);
	assert.equal(parseDateInput("2026-13-45"), undefined);
});

test("escapeLikePattern escapes wildcards", () =>
{
	assert.equal(escapeLikePattern("50%_off\\"), "50\\%\\_off\\\\");
});

test("readText trims and enforces the length cap", () =>
{
	assert.equal(readText("  Jan  ", 10), "Jan");
	assert.equal(readText("x".repeat(11), 10), undefined);
	assert.equal(readText(null, 10), "");
});

test("isOwnerEditableStatus allows pending and in-progress only", () =>
{
	assert.equal(isOwnerEditableStatus("pending"), true);
	assert.equal(isOwnerEditableStatus("in-progress"), true);
	assert.equal(isOwnerEditableStatus("shipped"), false);
	assert.equal(isOwnerEditableStatus("completed"), false);
	assert.deepEqual(OWNER_EDITABLE_STATUSES, ["pending", "in-progress"]);
});

test("isOwnerEditableStatus fails closed for unknown, empty and differently cased values", () =>
{
	assert.equal(isOwnerEditableStatus(""), false);
	assert.equal(isOwnerEditableStatus(null), false);
	assert.equal(isOwnerEditableStatus(undefined), false);
	assert.equal(isOwnerEditableStatus("SHIPPED"), false);
	assert.equal(isOwnerEditableStatus("PENDING"), false);
	assert.equal(isOwnerEditableStatus(" pending"), false);
	assert.equal(isOwnerEditableStatus("cancelled"), false);
});
