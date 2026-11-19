// Owner A must not reach owner B's orders or files through any user route;
// an admin can. The fake DB does not run SQL, so each test queues what
// Postgres would answer for the actor (nothing for A, the row for B or an
// admin) and checks that the query really carries the ownership filter that
// makes it so.

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { callRoute, harness, installRouteHarness, uninstallRouteHarness } from "./helpers/routeHarness.mjs";

// Run with `bun test --conditions react-server` so `server-only` resolves.
await installRouteHarness();

const { PUT: ownerModify } = await import("../src/app/api/modifyOrder/route.js");
const { PUT: adminModify } = await import("../src/app/api/admin/modifyOrder/route.js");
const { DELETE: ownerDelete } = await import("../src/app/api/deleteOrder/route.js");
const { DELETE: adminDelete } = await import("../src/app/api/admin/deleteOrder/route.js");
const { GET: downloadFile } = await import("../src/app/api/downloadFile/route.js");
const { POST: getFileNames } = await import("../src/app/api/getFileNames/route.js");

const originalSend = harness.s3.send;

afterAll(() =>
{
	uninstallRouteHarness();
});

beforeEach(() =>
{
	harness.reset();
	harness.s3.send = originalSend;
});

const ORDER_B = "0190b2a4-7c3e-7d2a-9f1b-3a5c6d7e8f90";
const USER_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const USER_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ADMIN = "22222222-2222-4222-8222-222222222222";
const FILE_B = "0190b2a4-0000-7000-8000-00000000000b";
const FILE_A = "0190b2a4-0000-7000-8000-00000000000a";

function logInAs(userId, role)
{
	harness.session.loggedIn = true;
	harness.session.userId = userId;
	harness.session.role = role;
}

const orderOfB = (overrides = {}) => ({ order_id: ORDER_B, status: "pending", files: [FILE_B], ...overrides });

function editForm(extra = {})
{
	const form = new FormData();

	form.append("orderID", ORDER_B);
	form.append("patient", "Jan Kowalski");
	form.append("details", "Korona 11");
	form.append("dueDate", "2026-12-01");

	for (const [name, value] of Object.entries(extra))
	{
		form.append(name, value);
	}

	return form;
}

const callModify = (handler, form = editForm()) =>
	callRoute(handler, { method: "PUT", url: "/api/modifyOrder", body: form });

const callDelete = (handler) =>
	callRoute(handler, { method: "DELETE", url: `/api/deleteOrder?orderID=${ORDER_B}` });

const callDownload = () =>
	callRoute(downloadFile, { url: `/api/downloadFile?file_id=${FILE_B}` });

const callFileNames = (fileIds) =>
	callRoute(getFileNames, { method: "POST", url: "/api/getFileNames", body: { fileIds } });

const queriesMatching = (pattern) => harness.db.queries.filter((query) => pattern.test(query.text));

const LOCK_QUERY = /^SELECT order_id, status, files FROM orders/;

function expectOwnerScoped(query, actorId)
{
	expect(query.text).toContain("user_id = ?");
	expect(query.values).toContain(actorId);
}

function expectNotOwnerScoped(query)
{
	expect(query.text).not.toContain("user_id");
}

function stubS3Download()
{
	harness.s3.send = async () => ({
		Body: new Blob(["secret"]).stream(),
		ContentLength: 6,
		ContentType: "application/octet-stream",
		Metadata: {},
	});
}

describe("PUT /api/modifyOrder", () =>
{
	test("owner A cannot modify owner B's order: 404 and nothing written", async () =>
	{
		logInAs(USER_A);
		harness.s3.seed(FILE_B);
		harness.db.queue([]);

		const res = await callModify(ownerModify);

		expect(res.status).toBe(404);
		expect(await res.json()).toEqual({ success: false, error: "Order not found" });

		const [select] = queriesMatching(LOCK_QUERY);

		expect(select.text).toContain("FOR UPDATE");
		expect(select.values).toEqual([ORDER_B, USER_A]);
		expect(queriesMatching(/^UPDATE/)).toEqual([]);
		expect(harness.s3.callsOf("DeleteObjects")).toEqual([]);
		expect(harness.s3.objects.has(FILE_B)).toBe(true);
	});

	test("a user id in the form is ignored; the session decides who the owner is", async () =>
	{
		logInAs(USER_A);
		harness.db.queue([]);

		const res = await callModify(ownerModify, editForm({ userID: USER_B, user_id: USER_B, ownerId: USER_B }));

		expect(res.status).toBe(404);
		expect(queriesMatching(LOCK_QUERY)[0].values).toEqual([ORDER_B, USER_A]);
	});

	test("owner B can modify the same order", async () =>
	{
		logInAs(USER_B);
		harness.db.queue([orderOfB()], [orderOfB()]);

		const res = await callModify(ownerModify, editForm({ existingFileIds: FILE_B }));

		expect(res.status).toBe(200);
		expectOwnerScoped(queriesMatching(LOCK_QUERY)[0], USER_B);
		expect(queriesMatching(/^UPDATE orders/)).toHaveLength(1);
	});

	test("an admin can modify it without an owner filter", async () =>
	{
		logInAs(ADMIN, "admin");
		harness.db.queue([orderOfB({ status: "shipped" })], [orderOfB()]);

		const res = await callModify(adminModify, editForm({ existingFileIds: FILE_B }));

		expect(res.status).toBe(200);
		expectNotOwnerScoped(queriesMatching(LOCK_QUERY)[0]);
		expect(queriesMatching(/^UPDATE orders/)).toHaveLength(1);
	});

	test("a non-admin is refused by the admin route before touching the database", async () =>
	{
		logInAs(USER_A);

		const res = await callModify(adminModify);

		expect(res.status).toBe(403);
		expect(harness.db.queries).toEqual([]);
	});
});

describe("DELETE /api/deleteOrder", () =>
{
	test("owner A cannot delete owner B's order: 404, the order and its files stay", async () =>
	{
		logInAs(USER_A);
		harness.s3.seed(FILE_B);
		harness.db.queue([]);

		const res = await callDelete(ownerDelete);

		expect(res.status).toBe(404);
		expect(await res.json()).toEqual({ success: false, error: "Order not found" });

		const [select] = queriesMatching(LOCK_QUERY);

		expect(select.text).toContain("FOR UPDATE");
		expect(select.values).toEqual([ORDER_B, USER_A]);
		expect(queriesMatching(/^DELETE/)).toEqual([]);
		expect(harness.s3.callsOf("DeleteObjects")).toEqual([]);
		expect(harness.s3.objects.has(FILE_B)).toBe(true);
	});

	test("owner B can delete it", async () =>
	{
		logInAs(USER_B);
		harness.s3.seed(FILE_B);
		harness.db.queue([orderOfB()]);

		const res = await callDelete(ownerDelete);

		expect(res.status).toBe(200);
		expectOwnerScoped(queriesMatching(LOCK_QUERY)[0], USER_B);
		expect(queriesMatching(/^DELETE FROM orders/)).toHaveLength(1);
		expect(harness.s3.deleted).toEqual([FILE_B]);
	});

	test("an admin can delete it without an owner filter", async () =>
	{
		logInAs(ADMIN, "admin");
		harness.s3.seed(FILE_B);
		harness.db.queue([orderOfB({ status: "completed" })]);

		const res = await callDelete(adminDelete);

		expect(res.status).toBe(200);
		expectNotOwnerScoped(queriesMatching(LOCK_QUERY)[0]);
		expect(queriesMatching(/^DELETE FROM orders/)).toHaveLength(1);
		expect(harness.s3.deleted).toEqual([FILE_B]);
	});

	test("a non-admin is refused by the admin route before touching the database", async () =>
	{
		logInAs(USER_A);

		const res = await callDelete(adminDelete);

		expect(res.status).toBe(403);
		expect(harness.db.queries).toEqual([]);
		expect(harness.s3.callsOf("DeleteObjects")).toEqual([]);
	});
});

describe("GET /api/downloadFile", () =>
{
	test("owner A cannot download a file of owner B's order: 404 and S3 is not read", async () =>
	{
		logInAs(USER_A);
		harness.s3.seed(FILE_B, { body: "secret" });
		harness.db.queue([]);

		const res = await callDownload();

		expect(res.status).toBe(404);
		expect(await res.json()).toEqual({ success: false, error: "File not found" });
		expect(harness.db.queries).toHaveLength(1);
		expectOwnerScoped(harness.db.queries[0], USER_A);
		expect(harness.s3.callsOf("GetObject")).toEqual([]);
	});

	test("owner B can download it", async () =>
	{
		logInAs(USER_B);
		harness.db.queue([{ file_id: FILE_B }]);
		stubS3Download();

		const res = await callDownload();

		expect(res.status).toBe(200);
		expectOwnerScoped(harness.db.queries[0], USER_B);

		await res.body?.cancel();
	});

	test("an admin gets the file without an owner filter", async () =>
	{
		logInAs(ADMIN, "admin");
		harness.db.queue([{ file_id: FILE_B }]);
		stubS3Download();

		const res = await callDownload();

		expect(res.status).toBe(200);
		expectNotOwnerScoped(harness.db.queries[0]);

		await res.body?.cancel();
	});

	test("a logged-out request is refused before any lookup", async () =>
	{
		const res = await callDownload();

		expect(res.status).toBe(403);
		expect(harness.db.queries).toEqual([]);
	});
});

describe("POST /api/getFileNames", () =>
{
	test("owner A asking for owner B's file gets nothing, and S3 is not probed", async () =>
	{
		logInAs(USER_A);
		harness.s3.seed(FILE_B, { metadata: { original_name: "secret.stl" } });
		harness.db.queue([]);

		const res = await callFileNames([FILE_B]);

		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ filenames: {} });
		expectOwnerScoped(harness.db.queries[0], USER_A);
		expect(harness.s3.callsOf("HeadObject")).toEqual([]);
	});

	test("a mixed request returns only the caller's own file", async () =>
	{
		logInAs(USER_A);
		harness.s3.seed(FILE_A, { metadata: { original_name: "mine.stl" } });
		harness.s3.seed(FILE_B, { metadata: { original_name: "secret.stl" } });
		harness.db.queue([{ file_id: FILE_A }]);

		const res = await callFileNames([FILE_A, FILE_B]);
		const { filenames } = await res.json();

		expect(filenames).toEqual({ [FILE_A]: "mine.stl" });
		expect(filenames).not.toHaveProperty(FILE_B);
		expect(harness.s3.callsOf("HeadObject").map((call) => call.key)).toEqual([FILE_A]);
	});

	test("an admin gets the names of any order's files without an owner filter", async () =>
	{
		logInAs(ADMIN, "admin");
		harness.s3.seed(FILE_B, { metadata: { original_name: "secret.stl" } });
		harness.db.queue([{ file_id: FILE_B }]);

		const res = await callFileNames([FILE_B]);

		expect(await res.json()).toEqual({ filenames: { [FILE_B]: "secret.stl" } });
		expectNotOwnerScoped(harness.db.queries[0]);
	});
});
