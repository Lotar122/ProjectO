import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { callRoute, harness, installRouteHarness, uninstallRouteHarness } from "./helpers/routeHarness.mjs";

// Run with `bun test --conditions react-server` so `server-only` resolves.
await installRouteHarness();

const { GET, DELETE } = await import("../src/app/api/admin/deleteAccountData/route.js");
const { recoveryPaths } = await import("../src/app/server-functions/orders/archiverRecovery.js");

const ADMIN_ID = "22222222-2222-4222-8222-222222222222";
const USER_ID = "11111111-1111-4111-8111-111111111111";
const ORDER_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ORDER_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const FILES_A = ["f0000000-0000-4000-8000-00000000000a", "f0000000-0000-4000-8000-00000000000b"];
const FILES_B = ["f0000000-0000-4000-8000-00000000000c"];
const ROUTE = "/api/admin/deleteAccountData";
const realFetch = globalThis.fetch;

let kratosCalls;
let recoveryDir;
let previousRecoveryDir;
let logSpies;

// Records the Kratos admin calls and the number of queries that had run by then.
function stubKratos({ status = 200, error } = {})
{
	kratosCalls = [];

	globalThis.fetch = async (url, init) =>
	{
		kratosCalls.push({ url: String(url), method: init?.method, queriesBefore: harness.db.queries.length });

		if (error)
		{
			throw error;
		}

		return new Response(null, { status });
	};
}

const send = (handler, options = {}) =>
{
	const { method = "GET" } = options;
	const id = Object.hasOwn(options, "id") ? options.id : USER_ID;

	return callRoute(handler, { method, url: id === undefined ? ROUTE : `${ROUTE}?id=${id}` });
};

const lockedRow = (orderID, files, deletionActive) => ({
	order_id: orderID,
	status: "pending",
	files,
	deleting_at: deletionActive ? new Date() : null,
	deletion_active: deletionActive,
});

// Queue for deleting one order that goes through: lock + mark, the archiver cleanup of its
// files (one journal lookup, `journalRows` are the rows found), then lock + delete the row.
const queueOrderDeleted = (orderID, files, journalRows = []) =>
{
	harness.db.queue(
		[lockedRow(orderID, files, false)],
		[{ marker: "2026-11-25 10:00:00+00" }],
		journalRows,
		...journalRows.flatMap(() => [[], []]),
		[lockedRow(orderID, files, true)],
		[{ order_id: orderID }],
	);
};

// Queue for an order whose deletion another request is still running.
const queueOrderBusy = (orderID, files) => harness.db.queue([lockedRow(orderID, files, true)]);

const OTHER_ID = "99999999-9999-4999-8999-999999999999";
const ARCHIVER_TEMP_NAME = "projecto-archive-12345678-1234-4234-8234-123456789abc";

const journalRow = (fileId, originalPath, { state = "uploaded", jobActive = false } = {}) => ({
	file_id: fileId,
	original_path: originalPath,
	state,
	job_active: jobActive,
});

// Makes rm() of the recovery copy fail with something other than ENOENT: a directory with a file in it.
async function blockRecoveryCopy(fileId)
{
	const { filePath } = recoveryPaths(fileId);

	await mkdir(filePath);
	await writeFile(path.join(filePath, "keep"), "x");

	return filePath;
}

const exists = (target) => stat(target).then(() => true, () => false);
const queryTexts = () => harness.db.queries.map((query) => query.text);
const indexOfQuery = (fragment) => queryTexts().findIndex((text) => text.includes(fragment));

afterAll(() =>
{
	uninstallRouteHarness();
});

beforeEach(async () =>
{
	harness.reset();
	harness.session.loggedIn = true;
	harness.session.userId = ADMIN_ID;
	harness.session.role = "admin";
	stubKratos();
	previousRecoveryDir = process.env.ARCHIVER_RECOVERY_DIR;
	recoveryDir = await mkdtemp(path.join(os.tmpdir(), "projecto-delete-account-"));
	process.env.ARCHIVER_RECOVERY_DIR = recoveryDir;
	logSpies = ["log", "warn", "error"].map((method) => spyOn(console, method).mockImplementation(() =>
	{
	}));
});

afterEach(async () =>
{
	globalThis.fetch = realFetch;
	logSpies.forEach((spy) => spy.mockRestore());

	if (previousRecoveryDir === undefined)
	{
		delete process.env.ARCHIVER_RECOVERY_DIR;
	}
	else
	{
		process.env.ARCHIVER_RECOVERY_DIR = previousRecoveryDir;
	}

	await rm(recoveryDir, { recursive: true, force: true });
});

describe("access and validation", () =>
{
	test("refuses a non-admin for preview and delete and touches nothing", async () =>
	{
		harness.session.role = "user";

		for (const [handler, method] of [[GET, "GET"], [DELETE, "DELETE"]])
		{
			const res = await send(handler, { method });

			expect(res.status).toBe(403);
			expect(await res.json()).toEqual({ success: false, error: "Admin access required" });
		}

		expect(harness.db.queries).toEqual([]);
		expect(kratosCalls).toEqual([]);
		expect(harness.s3.deleted).toEqual([]);
	});

	test("refuses a logged-out caller", async () =>
	{
		harness.session.loggedIn = false;

		expect((await send(DELETE, { method: "DELETE" })).status).toBe(403);
		expect(harness.db.queries).toEqual([]);
	});

	test("refuses the admin's own account", async () =>
	{
		for (const [handler, method] of [[GET, "GET"], [DELETE, "DELETE"]])
		{
			const res = await send(handler, { method, id: ADMIN_ID });

			expect(res.status).toBe(400);
			expect((await res.json()).error).toBe("Nie możesz usunąć własnego konta administratora.");
		}

		expect(harness.db.queries).toEqual([]);
		expect(kratosCalls).toEqual([]);
	});

	test("returns 400 for a missing or malformed id", async () =>
	{
		for (const id of [undefined, "", "not-a-uuid", USER_ID.slice(0, 12)])
		{
			for (const [handler, method] of [[GET, "GET"], [DELETE, "DELETE"]])
			{
				const res = await send(handler, { method, id });

				expect(res.status).toBe(400);
			}
		}

		expect(harness.db.queries).toEqual([]);
		expect(kratosCalls).toEqual([]);
	});

	test("rejects a cross-site delete", async () =>
	{
		const res = await callRoute(DELETE, {
			method: "DELETE",
			url: `${ROUTE}?id=${USER_ID}`,
			headers: { "sec-fetch-site": "cross-site" },
		});

		expect(res.status).toBe(403);
		expect(harness.db.queries).toEqual([]);
		expect(kratosCalls).toEqual([]);
	});
});

describe("GET preview", () =>
{
	test("returns the counts of orders, files and parties and changes nothing", async () =>
	{
		harness.db.queue([{ orders: 3, files: 7 }], [{ parties: 2 }]);

		const res = await send(GET);

		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ success: true, orders: 3, files: 7, parties: 2 });
		expect(queryTexts().every((text) => text.startsWith("SELECT"))).toBe(true);
		expect(harness.db.queries.every((query) => query.values[0] === USER_ID)).toBe(true);
		expect(kratosCalls).toEqual([]);
		expect(harness.s3.deleted).toEqual([]);
	});

	test("returns zeros for an account without data", async () =>
	{
		const res = await send(GET);

		expect(await res.json()).toEqual({ success: true, orders: 0, files: 0, parties: 0 });
	});
});

describe("DELETE account data", () =>
{
	test("deletes orders, then parties, the user row and finally the identity", async () =>
	{
		for (const fileId of [...FILES_A, ...FILES_B])
		{
			for (const target of Object.values(recoveryPaths(fileId)))
			{
				await writeFile(target, "x");
			}
		}

		await writeFile(path.join(recoveryDir, "unrelated.orig"), "x");
		harness.db.queue([
			{ order_id: ORDER_A, files: FILES_A },
			{ order_id: ORDER_B, files: FILES_B },
		]);
		queueOrderDeleted(ORDER_A, FILES_A);
		queueOrderDeleted(ORDER_B, FILES_B);
		harness.db.queue([{ remaining: 0 }], [{ id: "p1" }, { id: "p2" }], [], [{ remaining: 0 }]);

		const res = await send(DELETE, { method: "DELETE" });

		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({
			success: true,
			ordersDeleted: 2,
			filesDeleted: 3,
			partiesDeleted: 2,
			ordersRemaining: 0,
			leftovers: 0,
		});

		expect(harness.s3.deleted.sort()).toEqual([...FILES_A, ...FILES_B].sort());

		const orderDeletes = harness.db.queries.filter((query) => query.text.startsWith("DELETE FROM orders"));
		const partiesAt = indexOfQuery("DELETE FROM ordering_parties");
		const userAt = indexOfQuery("DELETE FROM users");

		expect(orderDeletes).toHaveLength(2);
		expect(harness.db.queries.lastIndexOf(orderDeletes[1])).toBeLessThan(partiesAt);
		expect(partiesAt).toBeLessThan(userAt);
		expect(harness.db.queries[partiesAt].values).toEqual([USER_ID, USER_ID]);
		expect(harness.db.queries[userAt].values).toEqual([USER_ID, USER_ID]);

		expect(kratosCalls).toHaveLength(1);
		expect(kratosCalls[0].method).toBe("DELETE");
		expect(kratosCalls[0].url).toEndWith(`/admin/identities/${USER_ID}`);
		expect(kratosCalls[0].queriesBefore).toBe(harness.db.queries.length);

		expect(await readdir(recoveryDir)).toEqual(["unrelated.orig"]);
	});

	test("logs one summary line with ids and counts only", async () =>
	{
		harness.db.queue([{ order_id: ORDER_A, files: FILES_A }]);
		queueOrderDeleted(ORDER_A, FILES_A);
		harness.db.queue([{ remaining: 0 }], [], [], [{ remaining: 0 }]);

		await send(DELETE, { method: "DELETE" });

		const lines = logSpies.flatMap((spy) => spy.mock.calls.map((args) => String(args[0])))
			.filter((line) => line.includes("deleted with all data"));

		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain(`Account ${USER_ID}`);
		expect(lines[0]).toContain(`admin ${ADMIN_ID}`);
		expect(lines[0]).toContain("orders 1, files 2, parties 0");
	});

	test("an account with no data still removes the identity", async () =>
	{
		harness.db.queue([], [{ remaining: 0 }], [], [], [{ remaining: 0 }]);

		const res = await send(DELETE, { method: "DELETE" });

		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ success: true, ordersDeleted: 0, filesDeleted: 0, partiesDeleted: 0, ordersRemaining: 0, leftovers: 0 });
		expect(kratosCalls).toHaveLength(1);
	});

	test("an order that cannot be deleted keeps the identity, parties and user row", async () =>
	{
		harness.db.queue([
			{ order_id: ORDER_A, files: FILES_A },
			{ order_id: ORDER_B, files: FILES_B },
		]);
		queueOrderDeleted(ORDER_A, FILES_A);
		queueOrderBusy(ORDER_B, FILES_B);
		harness.db.queue([{ remaining: 1 }]);

		const res = await send(DELETE, { method: "DELETE" });
		const body = await res.json();

		expect(res.status).toBe(409);
		expect(body.success).toBe(false);
		expect(body).toMatchObject({ ordersDeleted: 1, filesDeleted: 2, partiesDeleted: 0, ordersRemaining: 1 });
		expect(indexOfQuery("DELETE FROM ordering_parties")).toBe(-1);
		expect(indexOfQuery("DELETE FROM users")).toBe(-1);
		expect(kratosCalls).toEqual([]);
		expect(harness.s3.deleted.sort()).toEqual(FILES_A);
	});

	test("a failing order delete is reported as remaining and the others still go", async () =>
	{
		harness.db.queue([
			{ order_id: ORDER_A, files: FILES_A },
			{ order_id: ORDER_B, files: FILES_B },
		]);
		harness.db.queue(Object.assign(new Error("connection terminated"), { code: "08006", detail: "Key (patient)=(Jan Kowalski)" }));
		queueOrderDeleted(ORDER_B, FILES_B);
		harness.db.queue([{ remaining: 1 }]);

		const res = await send(DELETE, { method: "DELETE" });
		const body = await res.json();

		expect(res.status).toBe(409);
		expect(body).toMatchObject({ success: false, ordersDeleted: 1, filesDeleted: 1, ordersRemaining: 1 });
		expect(kratosCalls).toEqual([]);

		const logged = logSpies.flatMap((spy) => spy.mock.calls.map((args) => args.map(String).join(" "))).join("\n");

		expect(logged).not.toContain("Jan Kowalski");
	});

	test("files that cannot be removed keep the order, their recovery copies and the identity", async () =>
	{
		const originalSend = harness.s3.send;
		const realSend = originalSend.bind(harness.s3);

		harness.s3.send = async (command) =>
		{
			if (command.constructor.name === "DeleteObjectsCommand")
			{
				throw new Error("connect ECONNREFUSED");
			}

			return realSend(command);
		};

		for (const target of Object.values(recoveryPaths(FILES_A[0])))
		{
			await writeFile(target, "x");
		}

		harness.db.queue([{ order_id: ORDER_A, files: FILES_A }]);
		harness.db.queue(
			[lockedRow(ORDER_A, FILES_A, false)],
			[{ marker: "2026-11-25 10:00:00+00" }],
			[lockedRow(ORDER_A, FILES_A, true)],
			[{ order_id: ORDER_A }],
			[{ remaining: 1 }],
		);

		let res;

		try
		{
			res = await send(DELETE, { method: "DELETE" });
		}
		finally
		{
			harness.s3.send = originalSend;
		}

		const body = await res.json();

		expect(res.status).toBe(409);
		expect(body).toMatchObject({ success: false, ordersDeleted: 0, filesDeleted: 0, ordersRemaining: 1 });
		expect(kratosCalls).toEqual([]);
		expect(indexOfQuery("DELETE FROM users")).toBe(-1);
		expect((await readdir(recoveryDir)).sort()).toEqual(Object.values(recoveryPaths(FILES_A[0])).map((file) => path.basename(file)).sort());
	});

	test("running it again after a partial failure finishes the job", async () =>
	{
		harness.db.queue([
			{ order_id: ORDER_A, files: FILES_A },
			{ order_id: ORDER_B, files: FILES_B },
		]);
		queueOrderDeleted(ORDER_A, FILES_A);
		queueOrderBusy(ORDER_B, FILES_B);
		harness.db.queue([{ remaining: 1 }]);

		const first = await send(DELETE, { method: "DELETE" });

		expect(first.status).toBe(409);
		expect(kratosCalls).toEqual([]);

		harness.db.queue([{ order_id: ORDER_B, files: FILES_B }]);
		queueOrderDeleted(ORDER_B, FILES_B);
		harness.db.queue([{ remaining: 0 }], [{ id: "p1" }], [], [{ remaining: 0 }]);

		const second = await send(DELETE, { method: "DELETE" });

		expect(second.status).toBe(200);
		expect(await second.json()).toEqual({ success: true, ordersDeleted: 1, filesDeleted: 1, partiesDeleted: 1, ordersRemaining: 0, leftovers: 0 });
		expect(kratosCalls).toHaveLength(1);
		expect(harness.s3.deleted.sort()).toEqual([...FILES_A, ...FILES_B].sort());
	});

	test("treats an identity Kratos no longer knows as already deleted", async () =>
	{
		stubKratos({ status: 404 });
		harness.db.queue([], [{ remaining: 0 }], [], [], [{ remaining: 0 }]);

		const res = await send(DELETE, { method: "DELETE" });

		expect(res.status).toBe(200);
		expect((await res.json()).success).toBe(true);
	});

	test("a Kratos failure after the data is gone is not reported as success and can be retried", async () =>
	{
		stubKratos({ status: 500 });
		harness.db.queue([], [{ remaining: 0 }], [{ id: "p1" }], [], [{ remaining: 0 }]);

		const failed = await send(DELETE, { method: "DELETE" });
		const body = await failed.json();

		expect(failed.status).toBe(502);
		expect(body).toMatchObject({ success: false, partiesDeleted: 1, ordersRemaining: 0, leftovers: 0 });

		stubKratos();
		harness.db.queue([], [{ remaining: 0 }], [], [], [{ remaining: 0 }]);

		const retried = await send(DELETE, { method: "DELETE" });

		expect(retried.status).toBe(200);
		expect((await retried.json()).success).toBe(true);
	});

	test("a network error from Kratos is reported as a failure", async () =>
	{
		stubKratos({ error: new Error("connect ECONNREFUSED") });
		harness.db.queue([], [{ remaining: 0 }], [], [], [{ remaining: 0 }]);

		const res = await send(DELETE, { method: "DELETE" });

		expect(res.status).toBe(502);
		expect((await res.json()).success).toBe(false);
	});

	test("returns 500 without leaking details when the database fails before any delete", async () =>
	{
		harness.db.queue(Object.assign(new Error("connection terminated"), { code: "08006" }));

		const res = await send(DELETE, { method: "DELETE" });

		expect(res.status).toBe(500);
		expect(await res.json()).toEqual({ success: false, error: "Wewnętrzny błąd serwera" });
		expect(kratosCalls).toEqual([]);
	});
});

describe("DELETE account data: archiver leftovers", () =>
{
	test("a recovery file that cannot be removed keeps the order and blocks the identity, a re-run finishes", async () =>
	{
		const blocker = await blockRecoveryCopy(FILES_B[0]);

		harness.db.queue([{ order_id: ORDER_B, files: FILES_B }]);
		harness.db.queue(
			[lockedRow(ORDER_B, FILES_B, false)],
			[{ marker: "2026-11-25 10:00:00+00" }],
			[lockedRow(ORDER_B, FILES_B, true)],
			[{ order_id: ORDER_B }],
			[{ remaining: 1 }],
		);

		const failed = await send(DELETE, { method: "DELETE" });
		const body = await failed.json();

		expect(failed.status).toBe(409);
		expect(body).toMatchObject({ success: false, ordersDeleted: 0, filesDeleted: 0, ordersRemaining: 1 });
		expect(harness.s3.deleted).toEqual(FILES_B);
		expect(indexOfQuery("UPDATE orders")).toBeGreaterThan(-1);
		expect(indexOfQuery("DELETE FROM orders")).toBe(-1);
		expect(indexOfQuery("DELETE FROM users")).toBe(-1);
		expect(kratosCalls).toEqual([]);

		await rm(blocker, { recursive: true, force: true });
		harness.db.queue([{ order_id: ORDER_B, files: FILES_B }]);
		queueOrderDeleted(ORDER_B, FILES_B);
		harness.db.queue([{ remaining: 0 }], [], [], [{ remaining: 0 }]);

		const retried = await send(DELETE, { method: "DELETE" });

		expect(retried.status).toBe(200);
		expect(await retried.json()).toMatchObject({ success: true, ordersDeleted: 1, filesDeleted: 1 });
		expect(kratosCalls).toHaveLength(1);
	});

	test("an order someone else deleted still gets its recovery files removed", async () =>
	{
		for (const target of Object.values(recoveryPaths(FILES_A[0])))
		{
			await writeFile(target, "x");
		}

		harness.db.queue([{ order_id: ORDER_A, files: FILES_A }], [], []);
		harness.db.queue([{ remaining: 0 }], [], [], [{ remaining: 0 }]);

		const res = await send(DELETE, { method: "DELETE" });

		expect(res.status).toBe(200);
		expect(await res.json()).toMatchObject({ success: true, ordersDeleted: 0, filesDeleted: 0, leftovers: 0 });
		expect(await readdir(recoveryDir)).toEqual([]);
		expect(harness.s3.deleted).toEqual([]);
	});

	test("leftovers of an order that is already gone block the identity and the user row", async () =>
	{
		await blockRecoveryCopy(FILES_A[0]);
		harness.db.queue([{ order_id: ORDER_A, files: FILES_A }], []);
		harness.db.queue([{ remaining: 0 }]);

		const res = await send(DELETE, { method: "DELETE" });
		const body = await res.json();

		expect(res.status).toBe(409);
		expect(body).toMatchObject({ success: false, ordersRemaining: 0, leftovers: 1, partiesDeleted: 0 });
		expect(indexOfQuery("DELETE FROM ordering_parties")).toBe(-1);
		expect(indexOfQuery("DELETE FROM users")).toBe(-1);
		expect(kratosCalls).toEqual([]);
	});

	test("removes the journal row and its temp original, including a needs_attention row", async () =>
	{
		const tempOriginal = path.join(recoveryDir, ARCHIVER_TEMP_NAME);
		const foreign = path.join(recoveryDir, "not-an-archiver-file");

		await writeFile(tempOriginal, "x");
		await writeFile(foreign, "x");
		harness.db.queue([{ order_id: ORDER_A, files: FILES_A }]);
		queueOrderDeleted(ORDER_A, FILES_A, [
			journalRow(FILES_A[0], tempOriginal, { state: "needs_attention" }),
			journalRow(FILES_A[1], foreign, { jobActive: false }),
		]);
		harness.db.queue([{ remaining: 0 }], [], [], [{ remaining: 0 }]);

		const res = await send(DELETE, { method: "DELETE" });

		expect(res.status).toBe(200);
		expect(await exists(tempOriginal)).toBe(false);
		// Only files with the archiver's temp name are ever removed.
		expect(await exists(foreign)).toBe(true);

		const lookup = harness.db.queries.find((query) => query.text.includes("FROM archive_pending_verify p"));
		const deletes = harness.db.queries.filter((query) => query.text.startsWith("DELETE FROM archive_pending_verify"));

		expect(lookup.values).toEqual([FILES_A]);
		expect(deletes.map((query) => query.values[0])).toEqual(FILES_A);
		expect(deletes[0].text).toContain("needs_attention");
		expect(deletes[0].text).toContain("archive_jobs");
	});

	test("a journal row whose job is still running blocks the deletion and keeps its temp original", async () =>
	{
		const tempOriginal = path.join(recoveryDir, ARCHIVER_TEMP_NAME);

		await writeFile(tempOriginal, "x");
		harness.db.queue([{ order_id: ORDER_B, files: FILES_B }]);
		harness.db.queue(
			[lockedRow(ORDER_B, FILES_B, false)],
			[{ marker: "2026-11-25 10:00:00+00" }],
			[journalRow(FILES_B[0], tempOriginal, { state: "uploading", jobActive: true })],
			[lockedRow(ORDER_B, FILES_B, true)],
			[{ order_id: ORDER_B }],
			[{ remaining: 1 }],
		);

		const res = await send(DELETE, { method: "DELETE" });

		expect(res.status).toBe(409);
		expect(await res.json()).toMatchObject({ success: false, ordersRemaining: 1 });
		expect(await exists(tempOriginal)).toBe(true);
		expect(indexOfQuery("DELETE FROM archive_pending_verify")).toBe(-1);
		expect(indexOfQuery("DELETE FROM users")).toBe(-1);
		expect(kratosCalls).toEqual([]);
	});

	test("a journal row that cannot be removed is reported, not skipped", async () =>
	{
		harness.db.queue([{ order_id: ORDER_B, files: FILES_B }]);
		harness.db.queue(
			[lockedRow(ORDER_B, FILES_B, false)],
			[{ marker: "2026-11-25 10:00:00+00" }],
			[journalRow(FILES_B[0], "/nowhere/x")],
			new Error("deadlock detected"),
			[lockedRow(ORDER_B, FILES_B, true)],
			[{ order_id: ORDER_B }],
			[{ remaining: 1 }],
		);

		const res = await send(DELETE, { method: "DELETE" });

		expect(res.status).toBe(409);
		expect(kratosCalls).toEqual([]);
	});

	test("an order created after the count keeps the account and the user row", async () =>
	{
		harness.db.queue([], [{ remaining: 0 }], [], [], [{ remaining: 1 }]);

		const res = await send(DELETE, { method: "DELETE" });
		const body = await res.json();

		expect(res.status).toBe(409);
		expect(body).toMatchObject({ success: false, ordersRemaining: 1, partiesDeleted: 0 });
		expect(kratosCalls).toEqual([]);
		expect(harness.db.queries.at(-1).text).toContain("count(*)");

		for (const fragment of ["DELETE FROM ordering_parties", "DELETE FROM users"])
		{
			const query = harness.db.queries[indexOfQuery(fragment)];

			expect(query.text).toContain("NOT EXISTS (SELECT 1 FROM orders WHERE user_id = ?)");
		}
	});
});

describe("DELETE account data: other accounts", () =>
{
	test("never touches an order the account does not own, and scopes every lookup to the account", async () =>
	{
		// The list is read for USER_ID; the owner-scoped lock finds nothing for ORDER_B.
		harness.db.queue([{ order_id: ORDER_B, files: FILES_B }], [], []);
		harness.db.queue([{ remaining: 0 }]);

		await send(DELETE, { method: "DELETE" });

		const locks = harness.db.queries.filter((query) => query.text.includes("FOR UPDATE"));

		expect(locks).toHaveLength(1);
		expect(locks[0].text).toContain("AND user_id = ?");
		expect(locks[0].values).toContain(ORDER_B);
		expect(locks[0].values).toContain(USER_ID);
		expect(harness.db.queries.filter((query) => query.text.startsWith("UPDATE orders"))).toEqual([]);
		expect(harness.s3.deleted).toEqual([]);

		for (const query of harness.db.queries)
		{
			expect(query.values).not.toContain(OTHER_ID);

			if (query.text.includes("FROM orders") || query.text.includes("ordering_parties") || query.text.includes("FROM users"))
			{
				if (!query.text.includes("order_id = ?"))
				{
					expect(query.values).toContain(USER_ID);
				}
			}
		}
	});
});

describe("recoveryPaths", () =>
{
	test("uses the archiver's naming: URI-encoded id with .orig and .json", () =>
	{
		const { filePath, infoPath } = recoveryPaths("a b/c");

		expect(filePath).toBe(path.join(recoveryDir, "a%20b%2Fc.orig"));
		expect(infoPath).toBe(path.join(recoveryDir, "a%20b%2Fc.json"));
	});

	test("rejects an empty id", () =>
	{
		expect(() => recoveryPaths("")).toThrow(TypeError);
	});
});
