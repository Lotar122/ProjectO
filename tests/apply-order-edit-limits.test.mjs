// Per-order limit path of applyOrderEdit: the "limit" result and the effect of
// uploadedBytes, with the fake DB and S3 of the route harness.
//
// Run with `bun test --conditions react-server` so `server-only` resolves.

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { harness, installRouteHarness, uninstallRouteHarness } from "./helpers/routeHarness.mjs";

await installRouteHarness();

const { applyOrderEdit } = await import("../src/app/server-functions/orders/applyOrderEdit.js");
const { ARCHIVE_META } = await import("../src/app/server-functions/orders/fileCompression.js");
const { ORDER_LIMITS } = await import("../src/app/server-functions/orders/multipartUpload.js");

const ORDER_ID = "0190b2a4-7c3e-7d2a-9f1b-3a5c6d7e8f90";
const OWNER_ID = "11111111-1111-4111-8111-111111111111";
const fileId = (n) => `0190b2a4-0000-7000-8000-${String(n).padStart(12, "0")}`;
const FILE_A = fileId(1);
const FILE_B = fileId(2);
const FILE_C = fileId(3);
const NEW_1 = fileId(101);
const NEW_2 = fileId(102);

const LIMITS = { maxFiles: 3, maxFileBytes: 400, maxTotalBytes: 1000 };

const log = { error: () => undefined };

afterAll(() =>
{
	uninstallRouteHarness();
});

beforeEach(() =>
{
	harness.reset();
});

function seedFile(id, size, { archived = false, compressedSize = size } = {})
{
	harness.s3.seed(id, {
		body: Buffer.alloc(compressedSize),
		metadata: archived ? { [ARCHIVE_META.originalSize]: String(size) } : {},
	});
}

function edit(overrides = {})
{
	return applyOrderEdit({
		s3: harness.s3,
		orderID: ORDER_ID,
		ownerId: OWNER_ID,
		patient: "Jan Kowalski",
		details: "Korona 11",
		dueDate: "2026-12-01",
		existingFileIds: [],
		uploadedFileIds: [],
		fileNameUpdates: [],
		limits: LIMITS,
		log,
		...overrides,
	});
}

const updateQueries = () => harness.db.queries.filter((query) => /^UPDATE orders/.test(query.text));
const headCalls = () => harness.s3.callsOf("HeadObject").map((call) => call.key);

// Rows for the SELECT ... FOR UPDATE and then the UPDATE ... RETURNING.
function queueOrder(files, status = "new")
{
	harness.db.queue([{ order_id: ORDER_ID, status, files }], [{ order_id: ORDER_ID, files }]);
}

describe("applyOrderEdit per-order limits", () =>
{
	test("too many files is refused with a limit result and writes nothing", async () =>
	{
		seedFile(FILE_A, 10);
		seedFile(FILE_B, 10);
		queueOrder([FILE_A, FILE_B]);

		const outcome = await edit({
			existingFileIds: [FILE_A, FILE_B],
			uploadedFileIds: [NEW_1, NEW_2],
			uploadedBytes: 20,
		});

		expect(outcome).toEqual({ result: "limit", message: "At most 3 files per order" });
		expect(updateQueries()).toHaveLength(0);
		expect(harness.s3.callsOf("DeleteObjects")).toHaveLength(0);
		expect(harness.db.transactions.map((transaction) => transaction.outcome)).toEqual(["commit"]);
	});

	test("the count check skips the S3 size lookups", async () =>
	{
		queueOrder([FILE_A, FILE_B]);

		await edit({ existingFileIds: [FILE_A, FILE_B], uploadedFileIds: [NEW_1, NEW_2] });

		expect(headCalls()).toEqual([]);
	});

	test("duplicate existing ids are counted once", async () =>
	{
		seedFile(FILE_A, 10);
		queueOrder([FILE_A]);

		const outcome = await edit({
			existingFileIds: [FILE_A, FILE_A, FILE_A],
			uploadedFileIds: [NEW_1, NEW_2],
			uploadedBytes: 20,
		});

		expect(outcome.result).toBe("ok");
		expect(headCalls()).toEqual([FILE_A]);
	});

	test("kept bytes plus uploadedBytes over the total limit is refused", async () =>
	{
		seedFile(FILE_A, 400);
		seedFile(FILE_B, 400);
		queueOrder([FILE_A, FILE_B]);

		const outcome = await edit({
			existingFileIds: [FILE_A, FILE_B],
			uploadedFileIds: [NEW_1],
			uploadedBytes: 201,
		});

		expect(outcome).toEqual({ result: "limit", message: "Order files are too large in total" });
		expect(updateQueries()).toHaveLength(0);
	});

	test("exactly the total limit is accepted and uploadedBytes is what tips it over", async () =>
	{
		seedFile(FILE_A, 400);
		seedFile(FILE_B, 400);
		queueOrder([FILE_A, FILE_B]);

		const atLimit = await edit({
			existingFileIds: [FILE_A, FILE_B],
			uploadedFileIds: [NEW_1],
			uploadedBytes: 200,
		});

		expect(atLimit.result).toBe("ok");
		expect(updateQueries()).toHaveLength(1);

		harness.reset();
		seedFile(FILE_A, 400);
		seedFile(FILE_B, 400);
		queueOrder([FILE_A, FILE_B]);

		const overLimit = await edit({
			existingFileIds: [FILE_A, FILE_B],
			uploadedFileIds: [NEW_1],
			uploadedBytes: 201,
		});

		expect(overLimit.result).toBe("limit");
	});

	test("uploadedBytes defaults to 0, so only kept bytes and the file count are checked", async () =>
	{
		seedFile(FILE_A, 400);
		seedFile(FILE_B, 400);
		queueOrder([FILE_A, FILE_B]);

		const outcome = await edit({ existingFileIds: [FILE_A, FILE_B], uploadedFileIds: [NEW_1] });

		expect(outcome.result).toBe("ok");
	});

	test("an archived file counts with its original size, not its stored size", async () =>
	{
		seedFile(FILE_A, 400, { archived: true, compressedSize: 5 });
		seedFile(FILE_B, 400, { archived: true, compressedSize: 5 });
		queueOrder([FILE_A, FILE_B]);

		const outcome = await edit({
			existingFileIds: [FILE_A, FILE_B],
			uploadedFileIds: [NEW_1],
			uploadedBytes: 201,
		});

		expect(outcome).toEqual({ result: "limit", message: "Order files are too large in total" });
	});

	test("a non-numeric original size falls back to the stored size", async () =>
	{
		harness.s3.seed(FILE_A, { body: Buffer.alloc(300), metadata: { [ARCHIVE_META.originalSize]: "12abc" } });
		queueOrder([FILE_A]);

		const outcome = await edit({ existingFileIds: [FILE_A], uploadedFileIds: [NEW_1], uploadedBytes: 701 });

		expect(outcome.result).toBe("limit");
	});

	test("a kept file that is gone from storage takes no space", async () =>
	{
		queueOrder([FILE_A]);

		const outcome = await edit({ existingFileIds: [FILE_A], uploadedFileIds: [NEW_1], uploadedBytes: 1000 });

		expect(outcome.result).toBe("ok");
	});

	test("a file the client never saw counts as the largest allowed file", async () =>
	{
		seedFile(FILE_A, 100);
		seedFile(FILE_C, 1);
		// FILE_C was added by a concurrent edit: the client did not list it, nor know it.
		queueOrder([FILE_A, FILE_C]);

		const outcome = await edit({
			existingFileIds: [FILE_A],
			knownFileIds: [FILE_A],
			uploadedFileIds: [NEW_1],
			uploadedBytes: 1000 - 100 - LIMITS.maxFileBytes + 1,
		});

		expect(outcome).toEqual({ result: "limit", message: "Order files are too large in total" });
		expect(updateQueries()).toHaveLength(0);
		expect(harness.s3.callsOf("DeleteObjects")).toHaveLength(0);
	});

	test("removed files do not count towards the limits", async () =>
	{
		seedFile(FILE_A, 400);
		seedFile(FILE_B, 400);
		queueOrder([FILE_A, FILE_B]);

		const outcome = await edit({
			existingFileIds: [FILE_A],
			uploadedFileIds: [NEW_1],
			uploadedBytes: 600,
		});

		expect(outcome.result).toBe("ok");
		expect(outcome.removedFileIds).toEqual([FILE_B]);
	});

	test("an edit that adds no files is never refused, even for an order over the limits", async () =>
	{
		const crowded = [FILE_A, FILE_B, FILE_C, fileId(4), fileId(5)];

		for (const id of crowded)
		{
			seedFile(id, 400);
		}

		queueOrder(crowded);

		const outcome = await edit({ existingFileIds: crowded, uploadedBytes: 0 });

		expect(outcome.result).toBe("ok");
		expect(headCalls()).toEqual([]);
		expect(updateQueries()).toHaveLength(1);
		expect(updateQueries()[0].text).not.toContain("archived_at");
	});

	test("an accepted edit with uploads writes the new list and clears archived_at", async () =>
	{
		seedFile(FILE_A, 10);
		queueOrder([FILE_A]);

		const outcome = await edit({ existingFileIds: [FILE_A], uploadedFileIds: [NEW_1], uploadedBytes: 50 });

		expect(outcome.result).toBe("ok");
		expect(updateQueries()).toHaveLength(1);
		expect(updateQueries()[0].text).toContain("archived_at = NULL");
		expect(updateQueries()[0].values).toContainEqual([FILE_A, NEW_1]);
	});

	test("not found and locked take precedence over the early count refusal", async () =>
	{
		harness.db.queue([]);

		const notFound = await edit({ existingFileIds: [FILE_A, FILE_B], uploadedFileIds: [NEW_1, NEW_2] });

		expect(notFound).toEqual({ result: "not_found" });

		harness.reset();
		queueOrder([FILE_A], "shipped");

		const locked = await edit({
			existingFileIds: [FILE_A, FILE_B],
			uploadedFileIds: [NEW_1, NEW_2],
			assertEditable: (row) => row.status !== "shipped",
		});

		expect(locked).toEqual({ result: "locked" });
	});

	test("uses ORDER_LIMITS by default", async () =>
	{
		const existing = Array.from({ length: ORDER_LIMITS.maxFiles }, (_, index) => fileId(200 + index));

		queueOrder(existing);

		const outcome = await edit({ existingFileIds: existing, uploadedFileIds: [NEW_1], limits: undefined });

		expect(outcome).toEqual({ result: "limit", message: `At most ${ORDER_LIMITS.maxFiles} files per order` });
	});

	test.each([-1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1])("uploadedBytes %p is a RangeError", async (uploadedBytes) =>
	{
		await expect(edit({ uploadedBytes })).rejects.toThrow(RangeError);
		expect(harness.db.queries).toHaveLength(0);
	});

	test("limits without integer fields are a TypeError", async () =>
	{
		await expect(edit({ limits: { maxFiles: 3, maxFileBytes: 400 } })).rejects.toThrow(TypeError);
		await expect(edit({ limits: { maxFiles: "3", maxFileBytes: 400, maxTotalBytes: 1000 } })).rejects.toThrow(TypeError);
	});
});
