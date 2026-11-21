// W2 (atomic order edit and delete) and W16 (owner edit/delete lock from
// "shipped" on), driven through the real route handlers with the route harness.
// Also the deletion marker (orders.deleting_at) that keeps edits, status
// changes and other deletes away from an order while its files are deleted,
// and the 409 for a rename of a file the archiver is replacing (review
// 2026-11-20, item 3).

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { callRoute, harness, installRouteHarness, uninstallRouteHarness } from "./helpers/routeHarness.mjs";

await installRouteHarness();

const { PUT: ownerModify } = await import("../src/app/api/modifyOrder/route.js");
const { PUT: adminModify } = await import("../src/app/api/admin/modifyOrder/route.js");
const { DELETE: ownerDelete } = await import("../src/app/api/deleteOrder/route.js");
const { DELETE: adminDelete } = await import("../src/app/api/admin/deleteOrder/route.js");
const { PUT: adminUpdateStatus } = await import("../src/app/api/admin/updateOrderStatus/route.js");
const {
	DELETION_STALE_AFTER_MS,
	DELETION_STALE_INTERVAL,
	hasExpiredDeletionMarker,
	isDeletionActive,
} = await import("../src/app/server-functions/orders/orderRowLock.js");
const { readKnownFileIds } = await import("../src/app/server-functions/orders/applyOrderEdit.js");
const { DB } = await import("../src/app/lib/db.js");

afterAll(() =>
{
	uninstallRouteHarness();
});

beforeEach(() =>
{
	harness.reset();
});

const ORDER_ID = "0190b2a4-7c3e-7d2a-9f1b-3a5c6d7e8f90";
const OWNER_ID = "11111111-1111-4111-8111-111111111111";
const ADMIN_ID = "22222222-2222-4222-8222-222222222222";
const FILE_A = "0190b2a4-0000-7000-8000-00000000000a";
const FILE_B = "0190b2a4-0000-7000-8000-00000000000b";
const FILE_C = "0190b2a4-0000-7000-8000-00000000000c";

const EDIT_LOCKED_MESSAGE =
	"Tego zlecenia nie można już edytować, ponieważ ma status Gotowe lub Zrealizowane.";
const DELETE_LOCKED_MESSAGE =
	"Tego zlecenia nie można już usunąć, ponieważ ma status Gotowe lub Zrealizowane.";
const DELETE_RUNNING_MESSAGE =
	"To zlecenie jest właśnie usuwane. Odśwież listę zleceń za chwilę.";
const EDIT_DELETING_MESSAGE =
	"Tego zlecenia nie można już edytować, ponieważ jest właśnie usuwane.";
const STATUS_DELETING_MESSAGE =
	"Nie można zmienić statusu tego zlecenia, ponieważ jest właśnie usuwane.";
const FILE_BEING_ARCHIVED_MESSAGE =
	"Nie można teraz zmienić nazwy pliku, ponieważ jest właśnie archiwizowany. Spróbuj ponownie za kilka minut.";

function logInAs(role)
{
	harness.session.loggedIn = true;
	harness.session.userId = role === "admin" ? ADMIN_ID : OWNER_ID;
	harness.session.role = role === "admin" ? "admin" : undefined;
}

function buildEditForm({ existing = [], known, fileNames = [], uploads = [] } = {})
{
	const form = new FormData();

	form.append("orderID", ORDER_ID);
	form.append("patient", "Jan Kowalski");
	form.append("details", "Korona 11");
	form.append("dueDate", "2026-12-01");

	for (const fileId of existing)
	{
		form.append("existingFileIds", fileId);
	}

	if (known)
	{
		form.append("knownFileIds", JSON.stringify(known));
	}

	for (const update of fileNames)
	{
		form.append("fileNames", JSON.stringify(update));
	}

	for (const [name, body] of uploads)
	{
		form.append("files", new File([body], name));
	}

	return form;
}

// deletion_active is what the lock query computes on the database clock: the
// marker is set and younger than DELETION_STALE_AFTER_MS.
const lockedRow = (status, files = [FILE_A], deletingAt = null) => ({
	order_id: ORDER_ID,
	status,
	files,
	deleting_at: deletingAt,
	deletion_active: deletingAt !== null && Date.now() - deletingAt.getTime() < DELETION_STALE_AFTER_MS,
});

// What the marker UPDATE returns (the written timestamp as text), and what the
// guarded DELETE / UPDATE of the last step return when the marker is still ours.
const STALE_INTERVAL = "900 seconds";
const MARKER = "2026-11-21 10:00:00.123456+00";
const MARKED = [{ marker: MARKER }];
const WRITTEN = [{ order_id: ORDER_ID }];

// A deletion that started a minute ago (still running) and one older than the stale limit.
const runningMarker = () => new Date(Date.now() - 60_000);
const staleMarker = () => new Date(Date.now() - DELETION_STALE_AFTER_MS - 60_000);

const LOCK_QUERY = /^SELECT order_id, status, files, deleting_at, \(deleting_at IS NOT NULL AND deleting_at >= now\(\) - \?::interval\) AS deletion_active FROM orders/;
const MARKER_SET = /^UPDATE orders SET deleting_at = now\(\) WHERE order_id = \? RETURNING deleting_at::text AS marker$/;
const FINISH_UPDATE = /^UPDATE orders SET files = \?, deleting_at = NULL WHERE order_id = \? AND deleting_at::text = \? RETURNING order_id$/;
const ROW_DELETE = /^DELETE FROM orders WHERE order_id = \? AND deleting_at::text = \? RETURNING order_id$/;
const JOURNAL_QUERY = /^SELECT file_id FROM archive_pending_verify WHERE file_id = ANY\(\?::text\[\]\)$/;

const callModify = (handler, form) =>
	callRoute(handler, { method: "PUT", url: "/api/modifyOrder", body: form });

const callDelete = (handler) =>
	callRoute(handler, { method: "DELETE", url: `/api/deleteOrder?orderID=${ORDER_ID}` });

const callUpdateStatus = (status) =>
	callRoute(adminUpdateStatus, { method: "PUT", url: "/api/admin/updateOrderStatus", body: { orderID: ORDER_ID, status } });

const findQuery = (pattern) => harness.db.queries.findIndex((query) => pattern.test(query.text));

// Keys this request uploaded (PutObject), as opposed to seeded objects.
const uploadedKeys = () => harness.s3.callsOf("PutObject").map((call) => call.key);

const deletedKeysAt = () => harness.s3.calls.flatMap((call, index) =>
	call.type === "DeleteObjects"
		? call.input.Delete.Objects.map(({ Key }) => ({ key: Key, index }))
		: []);

// Every query of a transaction went through its handle, none through the outer DB.
function expectQueriesOnTransactionHandle()
{
	expect(harness.db.transactions.length).toBeGreaterThan(0);
	expect(harness.db.outerQueriesInTransaction).toEqual([]);

	for (const transaction of harness.db.transactions)
	{
		const inside = harness.db.queries.slice(transaction.queriesAtBegin, transaction.queriesAtEnd);

		expect(inside.length).toBeGreaterThan(0);
		expect(inside.every((query) => query.via === "tx")).toBe(true);
	}
}

// Makes DeleteObjects report every key as failed, like MinIO refusing the delete.
async function withFailingDeleteObjects(fn)
{
	const send = harness.s3.send;

	harness.s3.send = (command) =>
	{
		if (command?.constructor?.name !== "DeleteObjectsCommand")
		{
			return send(command);
		}

		harness.s3.calls.push({ type: "DeleteObjects", key: undefined, input: command.input });

		return Promise.resolve({
			Errors: command.input.Delete.Objects.map(({ Key }) => ({ Key, Code: "AccessDenied" })),
		});
	};

	try
	{
		await fn();
	}
	finally
	{
		harness.s3.send = send;
	}
}

// Replaces console.warn while `fn` runs and returns the lines it received.
async function captureWarnings(fn)
{
	const lines = [];
	const original = console.warn;

	console.warn = (...args) =>
	{
		lines.push(args.map(String).join(" "));
	};

	try
	{
		await fn();
	}
	finally
	{
		console.warn = original;
	}

	return lines;
}

function expectUploadsGone()
{
	const keys = uploadedKeys();

	expect(keys.length).toBeGreaterThan(0);

	for (const key of keys)
	{
		expect(harness.s3.deleted).toContain(key);
		expect(harness.s3.objects.has(key)).toBe(false);
	}
}

describe("PUT /api/modifyOrder (owner)", () =>
{
	test("locks the row inside DB.begin and updates it in the same transaction", async () =>
	{
		logInAs("owner");
		harness.s3.seed(FILE_A);
		harness.s3.seed(FILE_B);
		harness.db.queue([lockedRow("pending", [FILE_A, FILE_B])], [{ order_id: ORDER_ID, files: [FILE_A] }]);

		const res = await callModify(ownerModify, buildEditForm({ existing: [FILE_A] }));

		expect(res.status).toBe(200);
		expect((await res.json()).order).toEqual({ order_id: ORDER_ID, files: [FILE_A] });

		const [transaction] = harness.db.transactions;
		const selectIndex = findQuery(LOCK_QUERY);
		const updateIndex = findQuery(/^UPDATE orders/);
		const select = harness.db.queries[selectIndex];

		expect(harness.db.transactions).toHaveLength(1);
		expect(transaction.outcome).toBe("commit");
		expect(select.text).toContain("FOR UPDATE");
		expect(select.text).toContain("AND user_id = ?");
		expect(select.values).toEqual([STALE_INTERVAL, ORDER_ID, OWNER_ID]);
		expect(selectIndex).toBeGreaterThanOrEqual(transaction.queriesAtBegin);
		expect(updateIndex).toBeGreaterThan(selectIndex);
		expect(updateIndex).toBeLessThan(transaction.queriesAtEnd);
		expect(harness.db.queries[updateIndex].values).toContainEqual([FILE_A]);
		expectQueriesOnTransactionHandle();
	});

	test("deletes removed files only after the transaction committed", async () =>
	{
		logInAs("owner");
		harness.s3.seed(FILE_A);
		harness.s3.seed(FILE_B);
		harness.db.queue([lockedRow("in-progress", [FILE_A, FILE_B])], [{ order_id: ORDER_ID }]);

		const res = await callModify(ownerModify, buildEditForm({ existing: [FILE_A] }));

		expect(res.status).toBe(200);

		const [transaction] = harness.db.transactions;
		const deletions = deletedKeysAt();

		expect(deletions.map(({ key }) => key)).toEqual([FILE_B]);
		expect(deletions[0].index).toBeGreaterThanOrEqual(transaction.s3CallsAtEnd);
		expect(harness.s3.objects.has(FILE_A)).toBe(true);
		expect(harness.s3.objects.has(FILE_B)).toBe(false);
	});

	test("order missing at lock time: 404 and the uploads are deleted", async () =>
	{
		logInAs("owner");
		harness.db.queue([]);

		const res = await callModify(ownerModify, buildEditForm({ uploads: [["scan.stl", "solid"]] }));

		expect(res.status).toBe(404);
		expect(await res.json()).toEqual({ success: false, error: "Order not found" });
		expect(findQuery(/^UPDATE/)).toBe(-1);
		expectQueriesOnTransactionHandle();
		expectUploadsGone();
	});

	for (const status of ["pending", "in-progress"])
	{
		test(`${status}: the edit is saved with the uploads`, async () =>
		{
			logInAs("owner");
			harness.s3.seed(FILE_A);
			harness.db.queue([lockedRow(status)], [{ order_id: ORDER_ID, status }]);

			const res = await callModify(ownerModify, buildEditForm({
				existing: [FILE_A],
				uploads: [["scan.stl", "solid"]],
			}));
			const body = await res.json();
			const update = harness.db.queries[findQuery(/^UPDATE orders/)];

			expect(res.status).toBe(200);
			expect(body.success).toBe(true);
			expect(body.uploadedFiles).toHaveLength(1);
			// Adding files clears archived_at; the lock depends only on the status.
			expect(update.text).toContain("archived_at = NULL");
			expect(update.values).toContainEqual([FILE_A, body.uploadedFiles[0].fileID]);
			expect(harness.s3.objects.has(body.uploadedFiles[0].fileID)).toBe(true);
			expect(harness.s3.callsOf("DeleteObjects")).toEqual([]);
		});
	}

	for (const status of ["shipped", "completed", null, "cancelled"])
	{
		test(`${status}: 409 ORDER_LOCKED, nothing written, uploads deleted, files kept`, async () =>
		{
			logInAs("owner");
			harness.s3.seed(FILE_A);
			harness.s3.seed(FILE_B);
			harness.db.queue([lockedRow(status, [FILE_A, FILE_B])]);

			const res = await callModify(ownerModify, buildEditForm({
				existing: [FILE_A],
				uploads: [["scan.stl", "solid"]],
			}));

			expect(res.status).toBe(409);
			expect(await res.json()).toEqual({
				success: false,
				code: "ORDER_LOCKED",
				error: EDIT_LOCKED_MESSAGE,
			});
			expect(findQuery(/^UPDATE/)).toBe(-1);
			expect(harness.s3.objects.has(FILE_A)).toBe(true);
			expect(harness.s3.objects.has(FILE_B)).toBe(true);
			expect(harness.s3.deleted).not.toContain(FILE_B);
			expectQueriesOnTransactionHandle();
			expectUploadsGone();
		});
	}

	test("a failed UPDATE rolls back, deletes the uploads and keeps the removed files", async () =>
	{
		logInAs("owner");
		harness.s3.seed(FILE_A);
		harness.s3.seed(FILE_B);
		harness.db.queue([lockedRow("pending", [FILE_A, FILE_B])], new Error("connection lost"));

		const res = await callModify(ownerModify, buildEditForm({
			existing: [FILE_A],
			uploads: [["scan.stl", "solid"]],
		}));

		expect(res.status).toBe(500);
		expect(harness.db.transactions[0].outcome).toBe("rollback");
		expect(harness.s3.objects.has(FILE_B)).toBe(true);
		expectUploadsGone();
	});

	test("a failed rename after the commit keeps the saved edit and its uploads", async () =>
	{
		logInAs("owner");
		// FILE_A is not in storage, so renaming it fails after the commit.
		// Lock, then no archive journal row for the renamed file, then the UPDATE.
		harness.db.queue([lockedRow("pending", [FILE_A])], [], [{ order_id: ORDER_ID }]);

		const res = await callModify(ownerModify, buildEditForm({
			existing: [FILE_A],
			fileNames: [{ fileId: FILE_A, fileName: "nowa.stl" }],
			uploads: [["scan.stl", "solid"]],
		}));
		const body = await res.json();

		expect(res.status).toBe(200);
		expect(harness.s3.callsOf("HeadObject").some((call) => call.key === FILE_A)).toBe(true);
		expect(harness.s3.objects.has(body.uploadedFiles[0].fileID)).toBe(true);
		expect(harness.s3.callsOf("DeleteObjects")).toEqual([]);
		// The journal is checked under the row lock, on the files the order keeps.
		expect(findQuery(JOURNAL_QUERY)).toBeGreaterThan(findQuery(LOCK_QUERY));
		expect(findQuery(JOURNAL_QUERY)).toBeLessThan(harness.db.transactions[0].queriesAtEnd);
		expect(harness.db.queries[findQuery(JOURNAL_QUERY)].values).toEqual([[FILE_A]]);
		expect(harness.db.queries[findQuery(JOURNAL_QUERY)].via).toBe("tx");
	});

	test("renaming a file the archiver is replacing: 409 FILE_BEING_ARCHIVED, nothing saved, uploads deleted", async () =>
	{
		logInAs("owner");
		harness.s3.seed(FILE_A, { metadata: { original_name: "stara.stl" } });
		harness.db.queue([lockedRow("pending", [FILE_A])], [{ file_id: FILE_A }]);

		const res = await callModify(ownerModify, buildEditForm({
			existing: [FILE_A],
			fileNames: [{ fileId: FILE_A, fileName: "nowa.stl" }],
			uploads: [["scan.stl", "solid"]],
		}));

		expect(res.status).toBe(409);
		expect(await res.json()).toEqual({
			success: false,
			code: "FILE_BEING_ARCHIVED",
			error: FILE_BEING_ARCHIVED_MESSAGE,
		});
		expect(findQuery(/^UPDATE/)).toBe(-1);
		expect(harness.s3.callsOf("CopyObject").filter((call) => call.key === FILE_A)).toEqual([]);
		expect(harness.s3.objects.get(FILE_A).metadata.original_name).toBe("stara.stl");
		expectUploadsGone();
	});

	test("a file being archived whose name does not change does not block the edit", async () =>
	{
		logInAs("owner");
		// The client sends every name when the patient changes; this one is unchanged.
		harness.s3.seed(FILE_A, { metadata: { original_name: "nowa.stl" } });
		harness.db.queue([lockedRow("pending", [FILE_A])], [{ file_id: FILE_A }], [{ order_id: ORDER_ID }]);

		const res = await callModify(ownerModify, buildEditForm({
			existing: [FILE_A],
			fileNames: [{ fileId: FILE_A, fileName: "nowa.stl" }],
		}));

		expect(res.status).toBe(200);
		expect(findQuery(/^UPDATE orders/)).toBeGreaterThan(-1);
		expect(harness.s3.callsOf("CopyObject").filter((call) => call.key === FILE_A)).toEqual([]);
	});

	test("a journal row that appears after the check: the edit is saved, that file is not renamed", async () =>
	{
		logInAs("owner");
		harness.s3.seed(FILE_A, { metadata: { original_name: "stara.stl" } });
		// No row at the check under the lock, then the archiver inserts one before the copy.
		harness.db.queue([lockedRow("pending", [FILE_A])], [], [{ order_id: ORDER_ID }], [{ file_id: FILE_A }]);

		const res = await callModify(ownerModify, buildEditForm({
			existing: [FILE_A],
			fileNames: [{ fileId: FILE_A, fileName: "nowa.stl" }],
		}));
		const journalChecks = harness.db.queries.filter((query) => JOURNAL_QUERY.test(query.text));

		expect(res.status).toBe(200);
		expect(journalChecks).toHaveLength(2);
		// The second check ran after the commit, right before the copy, which it refused.
		expect(harness.db.queries.indexOf(journalChecks[1])).toBeGreaterThanOrEqual(harness.db.transactions[0].queriesAtEnd);
		expect(harness.s3.callsOf("CopyObject").filter((call) => call.key === FILE_A)).toEqual([]);
		expect(harness.s3.objects.get(FILE_A).metadata.original_name).toBe("stara.stl");
	});

	test("a foreign file id is never looked up in the archive journal", async () =>
	{
		logInAs("owner");
		// The client names a file of another order; only FILE_A is on this one.
		harness.s3.seed(FILE_A, { metadata: { original_name: "stara.stl" } });
		harness.s3.seed(FILE_B, { metadata: { original_name: "obca.stl" } });
		// A journal row would answer for FILE_B if it were asked about it.
		harness.db.queue([lockedRow("pending", [FILE_A])], [{ file_id: FILE_B }], [{ order_id: ORDER_ID }]);

		const res = await callModify(ownerModify, buildEditForm({
			existing: [FILE_A, FILE_B],
			known: [FILE_A],
			fileNames: [{ fileId: FILE_B, fileName: "nowa.stl" }],
		}));

		expect(res.status).toBe(200);
		expect(findQuery(JOURNAL_QUERY)).toBe(-1);
		expect(harness.s3.callsOf("HeadObject").filter((call) => call.key === FILE_B)).toEqual([]);
		expect(harness.s3.callsOf("CopyObject").filter((call) => call.key === FILE_B)).toEqual([]);
	});

	test("an order whose deletion has started: 409, nothing written, uploads deleted, files kept", async () =>
	{
		logInAs("owner");
		harness.s3.seed(FILE_A);
		harness.db.queue([lockedRow("pending", [FILE_A], runningMarker())]);

		const res = await callModify(ownerModify, buildEditForm({
			existing: [FILE_A],
			uploads: [["scan.stl", "solid"]],
		}));

		expect(res.status).toBe(409);
		expect(await res.json()).toEqual({ success: false, code: "ORDER_LOCKED", error: EDIT_DELETING_MESSAGE });
		expect(findQuery(/^UPDATE/)).toBe(-1);
		expect(harness.s3.objects.has(FILE_A)).toBe(true);
		expectQueriesOnTransactionHandle();
		expectUploadsGone();
	});

	test("knownFileIds: a file added by a concurrent edit is kept, a known file left out is removed", async () =>
	{
		logInAs("owner");
		harness.s3.seed(FILE_A);
		harness.s3.seed(FILE_B);
		harness.s3.seed(FILE_C);
		// FILE_C was added by another edit after this form was opened.
		harness.db.queue([lockedRow("pending", [FILE_A, FILE_B, FILE_C])], [{ order_id: ORDER_ID }]);

		const res = await callModify(ownerModify, buildEditForm({
			existing: [FILE_A],
			known: [FILE_A, FILE_B],
		}));

		expect(res.status).toBe(200);
		expect(harness.db.queries[findQuery(/^UPDATE orders/)].values).toContainEqual([FILE_A, FILE_C]);
		expect(harness.s3.deleted).toEqual([FILE_B]);
		expect(harness.s3.objects.has(FILE_C)).toBe(true);
	});

	for (const malformed of ["not json", "", JSON.stringify([1, 2]), JSON.stringify({ a: 1 })])
	{
		test(`malformed knownFileIds ${JSON.stringify(malformed)}: no file is removed and a warning is logged`, async () =>
		{
			logInAs("owner");
			harness.s3.seed(FILE_A);
			harness.s3.seed(FILE_B);
			harness.db.queue([lockedRow("pending", [FILE_A, FILE_B])], [{ order_id: ORDER_ID }]);

			const form = buildEditForm({ existing: [FILE_A] });

			form.append("knownFileIds", malformed);

			let res;
			const warnings = await captureWarnings(async () =>
			{
				res = await callModify(ownerModify, form);
			});

			expect(res.status).toBe(200);
			expect(harness.db.queries[findQuery(/^UPDATE orders/)].values).toContainEqual([FILE_A, FILE_B]);
			expect(harness.s3.callsOf("DeleteObjects")).toEqual([]);
			expect(harness.s3.objects.has(FILE_B)).toBe(true);
			expect(warnings.some((line) => line.includes("malformed knownFileIds"))).toBe(true);
		});
	}

	test("without knownFileIds every file left out is removed, as before", async () =>
	{
		logInAs("owner");
		harness.s3.seed(FILE_A);
		harness.s3.seed(FILE_C);
		harness.db.queue([lockedRow("pending", [FILE_A, FILE_C])], [{ order_id: ORDER_ID }]);

		const res = await callModify(ownerModify, buildEditForm({ existing: [FILE_A] }));

		expect(res.status).toBe(200);
		expect(harness.db.queries[findQuery(/^UPDATE orders/)].values).toContainEqual([FILE_A]);
		expect(harness.s3.deleted).toEqual([FILE_C]);
	});
});

describe("PUT /api/admin/modifyOrder", () =>
{
	test("same locked flow without the user_id filter", async () =>
	{
		logInAs("admin");
		harness.s3.seed(FILE_A);
		harness.s3.seed(FILE_B);
		harness.db.queue([lockedRow("pending", [FILE_A, FILE_B])], [{ order_id: ORDER_ID }]);

		const res = await callModify(adminModify, buildEditForm({ existing: [FILE_A] }));

		expect(res.status).toBe(200);

		const [transaction] = harness.db.transactions;
		const select = harness.db.queries[findQuery(LOCK_QUERY)];
		const deletion = deletedKeysAt()[0];

		expect(transaction.outcome).toBe("commit");
		expect(select.text).toContain("FOR UPDATE");
		expect(select.text).not.toContain("user_id");
		expect(select.values).toEqual([STALE_INTERVAL, ORDER_ID]);
		expect(findQuery(/^UPDATE orders/)).toBeLessThan(transaction.queriesAtEnd);
		expect(deletion).toEqual({ key: FILE_B, index: deletion.index });
		expect(deletion.index).toBeGreaterThanOrEqual(transaction.s3CallsAtEnd);
		expectQueriesOnTransactionHandle();
	});

	for (const status of ["shipped", "completed"])
	{
		test(`${status}: the admin can still edit`, async () =>
		{
			logInAs("admin");
			harness.s3.seed(FILE_A);
			harness.db.queue([lockedRow(status)], [{ order_id: ORDER_ID, status }]);

			const res = await callModify(adminModify, buildEditForm({
				existing: [FILE_A],
				uploads: [["scan.stl", "solid"]],
			}));

			expect(res.status).toBe(200);
			expect((await res.json()).order).toEqual({ order_id: ORDER_ID, status });
			expect(findQuery(/^UPDATE orders/)).toBeGreaterThan(-1);
		});
	}

	test("order missing at lock time: 404 and the uploads are deleted", async () =>
	{
		logInAs("admin");
		harness.db.queue([]);

		const res = await callModify(adminModify, buildEditForm({ uploads: [["scan.stl", "solid"]] }));

		expect(res.status).toBe(404);
		expect(findQuery(/^UPDATE/)).toBe(-1);
		expectUploadsGone();
	});

	test("an order with a running deletion marker: 409 for the admin too, nothing written", async () =>
	{
		logInAs("admin");
		harness.s3.seed(FILE_A);
		harness.db.queue([lockedRow("completed", [FILE_A], runningMarker())]);

		const res = await callModify(adminModify, buildEditForm({
			existing: [FILE_A],
			uploads: [["scan.stl", "solid"]],
		}));

		expect(res.status).toBe(409);
		expect(await res.json()).toEqual({ success: false, code: "ORDER_LOCKED", error: EDIT_DELETING_MESSAGE });
		expect(findQuery(/^UPDATE/)).toBe(-1);
		expectUploadsGone();
	});

	test("an order with a stale deletion marker (a delete that died) can be edited again", async () =>
	{
		logInAs("admin");
		harness.s3.seed(FILE_A);
		harness.db.queue([lockedRow("completed", [FILE_A], staleMarker())], [{ order_id: ORDER_ID }]);

		const res = await callModify(adminModify, buildEditForm({
			existing: [FILE_A],
			uploads: [["scan.stl", "solid"]],
		}));

		expect(res.status).toBe(200);
		expect(findQuery(/^UPDATE orders SET patient/)).toBeGreaterThan(-1);
		expect(harness.s3.callsOf("DeleteObjects")).toEqual([]);
	});

	test("renaming a file the archiver is replacing: 409 FILE_BEING_ARCHIVED for the admin too", async () =>
	{
		logInAs("admin");
		harness.s3.seed(FILE_A, { metadata: { original_name: "stara.stl" } });
		harness.db.queue([lockedRow("shipped", [FILE_A])], [{ file_id: FILE_A }]);

		const res = await callModify(adminModify, buildEditForm({
			existing: [FILE_A],
			fileNames: [{ fileId: FILE_A, fileName: "nowa.stl" }],
		}));

		expect(res.status).toBe(409);
		expect((await res.json()).code).toBe("FILE_BEING_ARCHIVED");
		expect(findQuery(/^UPDATE/)).toBe(-1);
		expect(harness.s3.callsOf("CopyObject").filter((call) => call.key === FILE_A)).toEqual([]);
	});
});

describe("PUT /api/admin/updateOrderStatus", () =>
{
	test("sets the status of an order that is not being deleted", async () =>
	{
		logInAs("admin");
		harness.db.queue([{ order_id: ORDER_ID, status: "shipped" }]);

		const res = await callUpdateStatus("shipped");
		const update = harness.db.queries[0];

		expect(res.status).toBe(200);
		// Only a marker younger than the stale limit blocks, judged on the database clock.
		expect(update.text).toContain("AND (orders.deleting_at IS NULL OR orders.deleting_at < now() - ?::interval)");
		expect(update.values).toContain(STALE_INTERVAL);
		expect(update.text).toContain("RETURNING order_id, status, progress");
		expect(harness.db.queries).toHaveLength(1);
	});

	test("an order whose deletion has started keeps its status: 409", async () =>
	{
		logInAs("admin");
		// The guarded UPDATE matches nothing, the existence check finds the row.
		harness.db.queue([], [{ "?column?": 1 }]);

		const res = await callUpdateStatus("shipped");

		expect(res.status).toBe(409);
		expect(await res.json()).toEqual({ success: false, code: "ORDER_LOCKED", error: STATUS_DELETING_MESSAGE });
	});

	test("a missing order is still a 404", async () =>
	{
		logInAs("admin");
		harness.db.queue([], []);

		const res = await callUpdateStatus("shipped");

		expect(res.status).toBe(404);
	});
});

// Answers for both transactions of a deletion: lock + marker, then re-lock +
// row delete (or the file list update when files are left).
const queueDeletion = (first, second = first) => harness.db.queue([first], MARKED, [second], WRITTEN);

describe("DELETE /api/deleteOrder (owner)", () =>
{
	for (const status of ["pending", "in-progress"])
	{
		test(`${status}: lock and mark, S3 delete outside any transaction, then locked row delete`, async () =>
		{
			logInAs("owner");
			harness.s3.seed(FILE_A);
			queueDeletion(lockedRow(status));

			const res = await callDelete(ownerDelete);

			expect(res.status).toBe(200);
			expect(await res.json()).toEqual({ success: true });

			const [first, second] = harness.db.transactions;
			const selects = harness.db.queries.filter((query) => LOCK_QUERY.test(query.text));
			const markerIndex = findQuery(MARKER_SET);
			const deleteIndex = findQuery(ROW_DELETE);
			const deletion = deletedKeysAt()[0];

			expect(harness.db.transactions).toHaveLength(2);
			expect(first.outcome).toBe("commit");
			expect(second.outcome).toBe("commit");
			expect(selects).toHaveLength(2);

			for (const select of selects)
			{
				expect(select.text).toContain("FOR UPDATE");
				expect(select.values).toEqual([STALE_INTERVAL, ORDER_ID, OWNER_ID]);
			}

			// The marker is set in the transaction that checked the status.
			expect(markerIndex).toBeGreaterThan(first.queriesAtBegin);
			expect(markerIndex).toBeLessThan(first.queriesAtEnd);
			expect(harness.db.queries[markerIndex].values).toEqual([ORDER_ID]);
			// No S3 call inside either transaction; the delete happens between them.
			expect(first.s3CallsAtEnd).toBe(first.s3CallsAtBegin);
			expect(second.s3CallsAtEnd).toBe(second.s3CallsAtBegin);
			expect(deletion.key).toBe(FILE_A);
			expect(deletion.index).toBeGreaterThanOrEqual(first.s3CallsAtEnd);
			expect(deletion.index).toBeLessThan(second.s3CallsAtBegin);
			expect(deleteIndex).toBeGreaterThanOrEqual(second.queriesAtBegin);
			expect(deleteIndex).toBeLessThan(second.queriesAtEnd);
			expect(harness.s3.objects.has(FILE_A)).toBe(false);
			expectQueriesOnTransactionHandle();
		});
	}

	for (const status of ["shipped", "completed", null, "cancelled"])
	{
		test(`${status}: 409 ORDER_LOCKED before any file is deleted or the order is marked`, async () =>
		{
			logInAs("owner");
			harness.s3.seed(FILE_A);
			harness.db.queue([lockedRow(status)]);

			const res = await callDelete(ownerDelete);

			expect(res.status).toBe(409);
			expect(await res.json()).toEqual({
				success: false,
				code: "ORDER_LOCKED",
				error: DELETE_LOCKED_MESSAGE,
			});
			expect(harness.s3.callsOf("DeleteObjects")).toEqual([]);
			expect(harness.s3.objects.has(FILE_A)).toBe(true);
			expect(findQuery(/^DELETE/)).toBe(-1);
			expect(findQuery(/^UPDATE/)).toBe(-1);
			expectQueriesOnTransactionHandle();
		});
	}

	test("missing order: 404, nothing deleted", async () =>
	{
		logInAs("owner");
		harness.db.queue([]);

		const res = await callDelete(ownerDelete);

		expect(res.status).toBe(404);
		expect(harness.s3.callsOf("DeleteObjects")).toEqual([]);
		expect(findQuery(/^DELETE/)).toBe(-1);
		expect(findQuery(/^UPDATE/)).toBe(-1);
	});

	test("files that could not be deleted: 500, no DELETE FROM orders, row kept and its marker cleared", async () =>
	{
		logInAs("owner");
		harness.s3.seed(FILE_A);
		queueDeletion(lockedRow("pending", [FILE_A], null), lockedRow("pending", [FILE_A], runningMarker()));

		await withFailingDeleteObjects(async () =>
		{
			const res = await callDelete(ownerDelete);

			expect(res.status).toBe(500);
			expect(await res.json()).toEqual({ success: false, error: "Wewnętrzny błąd serwera" });
		});

		const finish = harness.db.queries[findQuery(FINISH_UPDATE)];

		expect(harness.s3.callsOf("DeleteObjects")).toHaveLength(1);
		expect(findQuery(/^DELETE/)).toBe(-1);
		// Same files, no marker: the order is as it was before, status untouched.
		expect(finish.values).toEqual([[FILE_A], ORDER_ID, MARKER]);
		expect(finish.text).not.toContain("status");
		expect(harness.s3.objects.has(FILE_A)).toBe(true);
		expect(harness.db.transactions).toHaveLength(2);
		expectQueriesOnTransactionHandle();
	});

	test("a thrown S3 delete keeps the row and its file list and clears the marker; both transactions commit", async () =>
	{
		logInAs("owner");
		queueDeletion(lockedRow("pending"));

		const send = harness.s3.send;

		harness.s3.send = (command) => command?.constructor?.name === "DeleteObjectsCommand"
			? Promise.reject(new Error("S3 unavailable"))
			: send(command);

		try
		{
			const res = await callDelete(ownerDelete);

			expect(res.status).toBe(500);
			expect(harness.db.transactions.map((transaction) => transaction.outcome)).toEqual(["commit", "commit"]);
			expect(findQuery(/^DELETE/)).toBe(-1);
			expect(harness.db.queries[findQuery(FINISH_UPDATE)].values).toEqual([[FILE_A], ORDER_ID, MARKER]);
		}
		finally
		{
			harness.s3.send = send;
		}
	});

	test("another delete still running: 409 with its own message, nothing deleted, marker left alone", async () =>
	{
		logInAs("owner");
		harness.s3.seed(FILE_A);
		harness.db.queue([lockedRow("pending", [FILE_A], runningMarker())]);

		const res = await callDelete(ownerDelete);

		expect(res.status).toBe(409);
		expect(await res.json()).toEqual({ success: false, code: "ORDER_LOCKED", error: DELETE_RUNNING_MESSAGE });
		expect(harness.s3.callsOf("DeleteObjects")).toEqual([]);
		expect(findQuery(/^UPDATE/)).toBe(-1);
		expect(harness.s3.objects.has(FILE_A)).toBe(true);
	});

	test("a stale marker (a delete that died) is taken over and the deletion finishes", async () =>
	{
		logInAs("owner");
		harness.s3.seed(FILE_A);
		queueDeletion(lockedRow("pending", [FILE_A], staleMarker()));

		let res;
		const warnings = await captureWarnings(async () =>
		{
			res = await callDelete(ownerDelete);
		});

		expect(res.status).toBe(200);
		expect(findQuery(MARKER_SET)).toBeGreaterThan(-1);
		expect(findQuery(ROW_DELETE)).toBeGreaterThan(-1);
		expect(harness.s3.objects.has(FILE_A)).toBe(false);
		expect(warnings.some((line) => line.includes("stale deletion marker"))).toBe(true);
	});

	test("a takeover that rewrote the marker before the final step: nothing is deleted or cleared, 409", async () =>
	{
		logInAs("owner");
		harness.s3.seed(FILE_A);
		// Step 3 finds the row, but the guarded DELETE matches nothing: the marker is no longer ours.
		harness.db.queue([lockedRow("pending")], MARKED, [lockedRow("pending", [FILE_A], runningMarker())], []);

		const res = await callDelete(ownerDelete);

		expect(res.status).toBe(409);
		expect(await res.json()).toEqual({ success: false, code: "ORDER_LOCKED", error: DELETE_RUNNING_MESSAGE });

		const rowDelete = harness.db.queries[findQuery(ROW_DELETE)];

		// The row delete is conditional on the marker this request wrote in step 1.
		expect(rowDelete.values).toEqual([ORDER_ID, MARKER]);
		expect(findQuery(FINISH_UPDATE)).toBe(-1);
		// Taken over is an answer, not a failure: no retry of the final transaction.
		expect(harness.db.transactions.map((transaction) => transaction.outcome)).toEqual(["commit", "commit"]);
		expect(findQuery(/^DELETE FROM orders/)).toBe(findQuery(ROW_DELETE));
	});

	test("a takeover before the final step while files are left: the marker is not cleared, 409", async () =>
	{
		logInAs("owner");
		harness.s3.seed(FILE_A);
		harness.db.queue([lockedRow("pending")], MARKED, [lockedRow("pending", [FILE_A], runningMarker())], []);

		await withFailingDeleteObjects(async () =>
		{
			const res = await callDelete(ownerDelete);

			expect(res.status).toBe(409);
			expect((await res.json()).error).toBe(DELETE_RUNNING_MESSAGE);
		});

		expect(harness.db.queries[findQuery(FINISH_UPDATE)].values).toEqual([[FILE_A], ORDER_ID, MARKER]);
		expect(findQuery(/^DELETE/)).toBe(-1);
		expect(harness.db.transactions).toHaveLength(2);
	});

	test("the marker is written with RETURNING and handed back to the final step as text", async () =>
	{
		logInAs("owner");
		harness.s3.seed(FILE_A);
		queueDeletion(lockedRow("pending"));

		const res = await callDelete(ownerDelete);

		expect(res.status).toBe(200);
		expect(harness.db.queries[findQuery(MARKER_SET)].text).toContain("RETURNING deleting_at::text AS marker");
		expect(harness.db.queries[findQuery(ROW_DELETE)].values).toEqual([ORDER_ID, MARKER]);
	});

	test("the final transaction fails once: it is retried and the row is deleted", async () =>
	{
		logInAs("owner");
		harness.s3.seed(FILE_A);
		harness.db.queue([lockedRow("pending")], MARKED, new Error("connection lost"), [lockedRow("pending")], WRITTEN);

		const res = await callDelete(ownerDelete);

		expect(res.status).toBe(200);
		expect(harness.db.transactions.map((transaction) => transaction.outcome)).toEqual(["commit", "rollback", "commit"]);
		expect(findQuery(ROW_DELETE)).toBeGreaterThan(-1);
	});

	test("the final transaction fails twice: 500, the marker stays for the stale takeover", async () =>
	{
		logInAs("owner");
		harness.s3.seed(FILE_A);
		harness.db.queue([lockedRow("pending")], MARKED, new Error("connection lost"), new Error("connection lost"));

		const res = await callDelete(ownerDelete);

		expect(res.status).toBe(500);
		expect(harness.db.transactions.map((transaction) => transaction.outcome)).toEqual(["commit", "rollback", "rollback"]);
		expect(findQuery(FINISH_UPDATE)).toBe(-1);
		expect(findQuery(ROW_DELETE)).toBe(-1);
	});
});

describe("DELETE /api/deleteOrder (owner), racing other requests", () =>
{
	// Runs fn while the deletion is between its two transactions: right when
	// its DeleteObjects request is sent (other DeleteObjects pass through).
	async function duringFileDeletion(fn)
	{
		const send = harness.s3.send;
		let ran = false;
		let result;

		harness.s3.send = async (command) =>
		{
			if (!ran && command?.constructor?.name === "DeleteObjectsCommand")
			{
				ran = true;
				harness.s3.send = send;
				result = await fn();
			}

			return send(command);
		};

		try
		{
			const response = await callDelete(ownerDelete);

			return { response, result };
		}
		finally
		{
			harness.s3.send = send;
		}
	}

	test("an edit adding a file during the deletion gets 409 and the deletion finishes", async () =>
	{
		logInAs("owner");
		harness.s3.seed(FILE_A);
		// The deletion's first transaction: lock + marker.
		harness.db.queue([lockedRow("pending")], MARKED);

		const outcome = await duringFileDeletion(async () =>
		{
			// The edit locks the row after the marker was committed.
			harness.db.queue([lockedRow("pending", [FILE_A], runningMarker())]);

			const editResponse = await callModify(ownerModify, buildEditForm({
				existing: [FILE_A],
				uploads: [["scan.stl", "solid"]],
			}));

			// The deletion's second transaction: re-lock (files unchanged) + row delete.
			harness.db.queue([lockedRow("pending", [FILE_A], runningMarker())], WRITTEN);

			return { status: editResponse.status, body: await editResponse.json() };
		});

		expect(outcome.result).toEqual({
			status: 409,
			body: { success: false, code: "ORDER_LOCKED", error: EDIT_DELETING_MESSAGE },
		});
		expect(outcome.response.status).toBe(200);
		expect(await outcome.response.json()).toEqual({ success: true });
		expect(findQuery(/^UPDATE orders SET patient/)).toBe(-1);
		expect(findQuery(ROW_DELETE)).toBeGreaterThan(-1);
		expect(harness.s3.objects.has(FILE_A)).toBe(false);
		// The edit's upload was cleaned up instead of being left without an order.
		expectUploadsGone();
	});

	test("an admin status change during the deletion gets 409 and the owner's deletion finishes", async () =>
	{
		logInAs("owner");
		harness.s3.seed(FILE_A);
		harness.db.queue([lockedRow("pending")], MARKED);

		const outcome = await duringFileDeletion(async () =>
		{
			logInAs("admin");
			// The guarded UPDATE matches nothing; the row exists.
			harness.db.queue([], [{ "?column?": 1 }]);

			const statusResponse = await callUpdateStatus("shipped");

			harness.db.queue([lockedRow("pending")], WRITTEN);
			logInAs("owner");

			return statusResponse.status;
		});

		expect(outcome.result).toBe(409);
		expect(outcome.response.status).toBe(200);
		expect(findQuery(ROW_DELETE)).toBeGreaterThan(-1);
		expect(harness.s3.objects.has(FILE_A)).toBe(false);
	});

	test("a second delete during the deletion gets 409 and deletes nothing", async () =>
	{
		logInAs("owner");
		harness.s3.seed(FILE_A);
		harness.s3.seed(FILE_B);
		harness.db.queue([lockedRow("pending", [FILE_A, FILE_B])], MARKED);

		const outcome = await duringFileDeletion(async () =>
		{
			harness.db.queue([lockedRow("pending", [FILE_A, FILE_B], runningMarker())]);

			const second = await callDelete(ownerDelete);

			harness.db.queue([lockedRow("pending", [FILE_A, FILE_B], runningMarker())], WRITTEN);

			return { status: second.status, body: await second.json() };
		});

		expect(outcome.result).toEqual({
			status: 409,
			body: { success: false, code: "ORDER_LOCKED", error: DELETE_RUNNING_MESSAGE },
		});
		expect(outcome.response.status).toBe(200);
		// One DeleteObjects request: the second delete never reached S3.
		expect(harness.s3.callsOf("DeleteObjects")).toHaveLength(1);
		expect(harness.db.queries.filter((query) => MARKER_SET.test(query.text))).toHaveLength(1);
	});

	test("some files not deleted: 500, only the deleted ids leave orders.files, marker cleared", async () =>
	{
		logInAs("owner");
		harness.s3.seed(FILE_A);
		harness.s3.seed(FILE_B);
		queueDeletion(lockedRow("pending", [FILE_A, FILE_B]));

		const send = harness.s3.send;

		harness.s3.send = (command) =>
		{
			if (command?.constructor?.name !== "DeleteObjectsCommand")
			{
				return send(command);
			}

			harness.s3.objects.delete(FILE_A);

			return Promise.resolve({ Errors: [{ Key: FILE_B, Code: "AccessDenied" }] });
		};

		try
		{
			const res = await callDelete(ownerDelete);

			expect(res.status).toBe(500);
		}
		finally
		{
			harness.s3.send = send;
		}

		expect(harness.db.queries[findQuery(FINISH_UPDATE)].values).toEqual([[FILE_B], ORDER_ID, MARKER]);
		expect(findQuery(/^DELETE/)).toBe(-1);
		expect(harness.s3.objects.has(FILE_B)).toBe(true);
	});

	test("the status is not checked again at the end: the marker kept it from changing", async () =>
	{
		logInAs("owner");
		harness.s3.seed(FILE_A);
		// Even if the re-locked row showed another status, the deletion finishes.
		queueDeletion(lockedRow("pending"), lockedRow("shipped", [FILE_A], runningMarker()));

		const res = await callDelete(ownerDelete);

		expect(res.status).toBe(200);
		expect(findQuery(ROW_DELETE)).toBeGreaterThan(-1);
	});
});

describe("DELETE /api/admin/deleteOrder", () =>
{
	for (const status of ["pending", "completed"])
	{
		test(`${status}: deleted under the row lock without a status check`, async () =>
		{
			logInAs("admin");
			harness.s3.seed(FILE_A);
			queueDeletion(lockedRow(status));

			const res = await callDelete(adminDelete);

			expect(res.status).toBe(200);

			const [first, second] = harness.db.transactions;
			const selects = harness.db.queries.filter((query) => LOCK_QUERY.test(query.text));

			expect(harness.db.transactions).toHaveLength(2);
			expect(selects).toHaveLength(2);

			for (const select of selects)
			{
				expect(select.text).toContain("FOR UPDATE");
				expect(select.text).not.toContain("user_id");
			}

			expect(findQuery(MARKER_SET)).toBeLessThan(first.queriesAtEnd);
			expect(findQuery(ROW_DELETE)).toBeGreaterThanOrEqual(second.queriesAtBegin);
			expect(findQuery(ROW_DELETE)).toBeLessThan(second.queriesAtEnd);
			expect(harness.s3.objects.has(FILE_A)).toBe(false);
			expectQueriesOnTransactionHandle();
		});
	}

	test("files that could not be deleted: 500, no DELETE FROM orders, row kept and its marker cleared", async () =>
	{
		logInAs("admin");
		harness.s3.seed(FILE_A);
		queueDeletion(lockedRow("completed"));

		await withFailingDeleteObjects(async () =>
		{
			const res = await callDelete(adminDelete);

			expect(res.status).toBe(500);
		});

		expect(harness.s3.callsOf("DeleteObjects")).toHaveLength(1);
		expect(findQuery(/^DELETE/)).toBe(-1);
		expect(harness.db.queries[findQuery(FINISH_UPDATE)].values).toEqual([[FILE_A], ORDER_ID, MARKER]);
		expect(harness.s3.objects.has(FILE_A)).toBe(true);
		expectQueriesOnTransactionHandle();
	});

	test("another delete still running: 409, nothing deleted", async () =>
	{
		logInAs("admin");
		harness.s3.seed(FILE_A);
		harness.db.queue([lockedRow("completed", [FILE_A], runningMarker())]);

		const res = await callDelete(adminDelete);

		expect(res.status).toBe(409);
		expect(await res.json()).toEqual({ success: false, code: "ORDER_LOCKED", error: DELETE_RUNNING_MESSAGE });
		expect(harness.s3.callsOf("DeleteObjects")).toEqual([]);
		expect(findQuery(/^UPDATE/)).toBe(-1);
	});

	test("missing order: 404, nothing deleted", async () =>
	{
		logInAs("admin");
		harness.db.queue([]);

		const res = await callDelete(adminDelete);

		expect(res.status).toBe(404);
		expect(harness.s3.callsOf("DeleteObjects")).toEqual([]);
		expect(findQuery(/^DELETE/)).toBe(-1);
	});
});

describe("route harness transactions", () =>
{
	test("a query on the outer DB inside DB.begin is recorded as bypassing the transaction", async () =>
	{
		await DB.begin(async (sql) =>
		{
			await sql`SELECT 1`;
			await DB`SELECT 2`;
		});
		await DB`SELECT 3`;

		expect(harness.db.queries.map(({ text, via, inTransaction }) => ({ text, via, inTransaction }))).toEqual([
			{ text: "SELECT 1", via: "tx", inTransaction: true },
			{ text: "SELECT 2", via: "db", inTransaction: true },
			{ text: "SELECT 3", via: "db", inTransaction: false },
		]);
		expect(harness.db.outerQueriesInTransaction.map(({ text }) => text)).toEqual(["SELECT 2"]);
	});
});

describe("readKnownFileIds", () =>
{
	const warnings = [];
	const log = { warn: (line) => warnings.push(line) };
	const read = (value) => readKnownFileIds(value, { log, orderID: ORDER_ID });

	test("absent is null, a JSON array of strings is returned as is", () =>
	{
		expect(read(null)).toBeNull();
		expect(read(JSON.stringify([FILE_A, FILE_B]))).toEqual([FILE_A, FILE_B]);
		expect(read("[]")).toEqual([]);
		expect(warnings).toEqual([]);
	});

	test("present but malformed reads as an empty list (remove nothing) and warns", () =>
	{
		for (const value of ["", "not json", JSON.stringify([1, 2]), JSON.stringify({ a: 1 }), "null"])
		{
			expect(read(value)).toEqual([]);
		}

		expect(warnings).toHaveLength(5);
		expect(() => readKnownFileIds("[]", {})).toThrow(TypeError);
	});
});

describe("deletion marker helpers", () =>
{
	test("the stale limit is 15 minutes, in ms and as the interval every query uses", () =>
	{
		expect(DELETION_STALE_AFTER_MS).toBe(15 * 60 * 1000);
		expect(DELETION_STALE_INTERVAL).toBe("900 seconds");
	});

	test("active follows the database's answer, not the application clock", () =>
	{
		// A marker that looks recent to this process but expired on the database clock is not active.
		expect(isDeletionActive({ deleting_at: runningMarker(), deletion_active: false })).toBe(false);
		expect(isDeletionActive({ deleting_at: staleMarker(), deletion_active: true })).toBe(true);
		expect(isDeletionActive({ deleting_at: null, deletion_active: false })).toBe(false);
		expect(hasExpiredDeletionMarker({ deleting_at: staleMarker(), deletion_active: false })).toBe(true);
		expect(hasExpiredDeletionMarker({ deleting_at: null, deletion_active: false })).toBe(false);
		expect(hasExpiredDeletionMarker({ deleting_at: runningMarker(), deletion_active: true })).toBe(false);
	});

	test("a row without the computed flag fails closed: any marker counts as active", () =>
	{
		expect(isDeletionActive({ deleting_at: staleMarker() })).toBe(true);
		expect(isDeletionActive({ deleting_at: null })).toBe(false);
		expect(isDeletionActive(undefined)).toBe(false);
	});
});
