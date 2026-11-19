// W2 (atomic order edit and delete) and W16 (owner edit/delete lock from
// "shipped" on), driven through the real route handlers with the route harness.

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { callRoute, harness, installRouteHarness, uninstallRouteHarness } from "./helpers/routeHarness.mjs";

await installRouteHarness();

const { PUT: ownerModify } = await import("../src/app/api/modifyOrder/route.js");
const { PUT: adminModify } = await import("../src/app/api/admin/modifyOrder/route.js");
const { DELETE: ownerDelete } = await import("../src/app/api/deleteOrder/route.js");
const { DELETE: adminDelete } = await import("../src/app/api/admin/deleteOrder/route.js");
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

const lockedRow = (status, files = [FILE_A]) => ({ order_id: ORDER_ID, status, files });

const callModify = (handler, form) =>
	callRoute(handler, { method: "PUT", url: "/api/modifyOrder", body: form });

const callDelete = (handler) =>
	callRoute(handler, { method: "DELETE", url: `/api/deleteOrder?orderID=${ORDER_ID}` });

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
		const selectIndex = findQuery(/^SELECT order_id, status, files FROM orders/);
		const updateIndex = findQuery(/^UPDATE orders/);
		const select = harness.db.queries[selectIndex];

		expect(harness.db.transactions).toHaveLength(1);
		expect(transaction.outcome).toBe("commit");
		expect(select.text).toContain("FOR UPDATE");
		expect(select.text).toContain("AND user_id = ?");
		expect(select.values).toEqual([ORDER_ID, OWNER_ID]);
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
		harness.db.queue([lockedRow("pending", [FILE_A])], [{ order_id: ORDER_ID }]);

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
		const select = harness.db.queries[findQuery(/^SELECT order_id, status, files FROM orders/)];
		const deletion = deletedKeysAt()[0];

		expect(transaction.outcome).toBe("commit");
		expect(select.text).toContain("FOR UPDATE");
		expect(select.text).not.toContain("user_id");
		expect(select.values).toEqual([ORDER_ID]);
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
});

describe("DELETE /api/deleteOrder (owner)", () =>
{
	for (const status of ["pending", "in-progress"])
	{
		test(`${status}: lock, file delete and row delete run in one transaction`, async () =>
		{
			logInAs("owner");
			harness.s3.seed(FILE_A);
			harness.db.queue([lockedRow(status)], []);

			const res = await callDelete(ownerDelete);

			expect(res.status).toBe(200);
			expect(await res.json()).toEqual({ success: true });

			const [transaction] = harness.db.transactions;
			const select = harness.db.queries[findQuery(/^SELECT order_id, status, files FROM orders/)];
			const deleteIndex = findQuery(/^DELETE FROM orders/);
			const deletion = deletedKeysAt()[0];

			expect(transaction.outcome).toBe("commit");
			expect(select.text).toContain("FOR UPDATE");
			expect(select.values).toEqual([ORDER_ID, OWNER_ID]);
			expect(deleteIndex).toBeGreaterThan(-1);
			expect(deleteIndex).toBeLessThan(transaction.queriesAtEnd);
			expect(deletion.key).toBe(FILE_A);
			expect(deletion.index).toBeGreaterThanOrEqual(transaction.s3CallsAtBegin);
			expect(deletion.index).toBeLessThan(transaction.s3CallsAtEnd);
			expect(harness.s3.objects.has(FILE_A)).toBe(false);
			expectQueriesOnTransactionHandle();
		});
	}

	for (const status of ["shipped", "completed", null, "cancelled"])
	{
		test(`${status}: 409 ORDER_LOCKED before any file is deleted`, async () =>
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
	});

	test("files that could not be deleted: 500, no DELETE FROM orders, row kept", async () =>
	{
		logInAs("owner");
		harness.s3.seed(FILE_A);
		harness.db.queue([lockedRow("pending")]);

		await withFailingDeleteObjects(async () =>
		{
			const res = await callDelete(ownerDelete);

			expect(res.status).toBe(500);
			expect(await res.json()).toEqual({ success: false, error: "Wewnętrzny błąd serwera" });
		});

		expect(harness.s3.callsOf("DeleteObjects")).toHaveLength(1);
		expect(findQuery(/^DELETE/)).toBe(-1);
		expect(harness.s3.objects.has(FILE_A)).toBe(true);
		expectQueriesOnTransactionHandle();
	});

	test("a failed S3 delete rolls back and keeps the row", async () =>
	{
		logInAs("owner");
		harness.db.queue([lockedRow("pending")]);

		const send = harness.s3.send;

		harness.s3.send = (command) => command?.constructor?.name === "DeleteObjectsCommand"
			? Promise.reject(new Error("S3 unavailable"))
			: send(command);

		try
		{
			const res = await callDelete(ownerDelete);

			expect(res.status).toBe(500);
			expect(harness.db.transactions[0].outcome).toBe("rollback");
			expect(findQuery(/^DELETE/)).toBe(-1);
		}
		finally
		{
			harness.s3.send = send;
		}
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
			harness.db.queue([lockedRow(status)], []);

			const res = await callDelete(adminDelete);

			expect(res.status).toBe(200);

			const [transaction] = harness.db.transactions;
			const select = harness.db.queries[findQuery(/^SELECT order_id, status, files FROM orders/)];

			expect(select.text).toContain("FOR UPDATE");
			expect(select.text).not.toContain("user_id");
			expect(findQuery(/^DELETE FROM orders/)).toBeLessThan(transaction.queriesAtEnd);
			expect(harness.s3.objects.has(FILE_A)).toBe(false);
			expectQueriesOnTransactionHandle();
		});
	}

	test("files that could not be deleted: 500, no DELETE FROM orders, row kept", async () =>
	{
		logInAs("admin");
		harness.s3.seed(FILE_A);
		harness.db.queue([lockedRow("completed")]);

		await withFailingDeleteObjects(async () =>
		{
			const res = await callDelete(adminDelete);

			expect(res.status).toBe(500);
		});

		expect(harness.s3.callsOf("DeleteObjects")).toHaveLength(1);
		expect(findQuery(/^DELETE/)).toBe(-1);
		expect(harness.s3.objects.has(FILE_A)).toBe(true);
		expectQueriesOnTransactionHandle();
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
