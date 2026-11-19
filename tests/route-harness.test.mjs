import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { callRoute, harness, installRouteHarness, uninstallRouteHarness } from "./helpers/routeHarness.mjs";

await installRouteHarness();

const { PUT } = await import("../src/app/api/modifyOrder/route.js");
const { DB } = await import("../src/app/lib/db.js");
const { getUserAuthSession } = await import("../src/app/server-functions/getUserAuthSession.js");
const { createS3Client } = await import("../src/app/server-functions/MinIO/createS3Client.js");
const { cookies } = await import("next/headers");

afterAll(() =>
{
	uninstallRouteHarness();
});

beforeEach(() =>
{
	harness.reset();
});

describe("PUT /api/modifyOrder", () =>
{
	test("returns 403 when logged out", async () =>
	{
		const res = await callRoute(PUT, { method: "PUT", url: "/api/modifyOrder", body: new FormData() });

		expect(res.status).toBe(403);
		expect(await res.json()).toEqual({ success: false, error: "Forbidden" });
		expect(harness.authCalls).toBe(1);
		expect(harness.db.queries).toEqual([]);
		expect(harness.s3.calls).toEqual([]);
	});

	test("rejects a cross-site write before the handler runs", async () =>
	{
		harness.session.loggedIn = true;

		const res = await callRoute(PUT, {
			method: "PUT",
			url: "/api/modifyOrder",
			headers: { "sec-fetch-site": "cross-site" },
			body: new FormData(),
		});

		expect(res.status).toBe(403);
		expect(harness.authCalls).toBe(0);
	});
});

describe("route harness", () =>
{
	test("cookies() exposes ory_kratos_session only when set", async () =>
	{
		expect((await cookies()).get("ory_kratos_session")).toBeUndefined();

		harness.cookies.setSession("abc");

		expect((await cookies()).get("ory_kratos_session")).toEqual({ name: "ory_kratos_session", value: "abc" });
	});

	test("getUserAuthSession follows the configured session", async () =>
	{
		expect((await getUserAuthSession(await cookies())).loggedIn).toBe(false);

		harness.session.loggedIn = true;
		harness.session.userId = "user-7";
		harness.session.role = "admin";

		const session = await getUserAuthSession(await cookies());

		expect(session.loggedIn).toBe(true);
		expect(session.data.identity.id).toBe("user-7");
		expect(session.data.identity.metadata_public.role).toBe("admin");
	});

	test("DB records queries, returns queued rows and flattens nested fragments", async () =>
	{
		harness.db.queue([{ order_id: "o1" }], [{ ok: true }]);

		const [first] = await DB`SELECT * FROM orders WHERE order_id = ${"o1"}`;
		const flag = true;
		const second = await DB`
			UPDATE orders SET patient = ${"Jan"}
			${flag ? DB`, archived_at = NULL` : DB``}
			WHERE order_id = ${"o1"}
		`;
		const empty = await DB`SELECT 1`;

		expect(first).toEqual({ order_id: "o1" });
		expect(second).toEqual([{ ok: true }]);
		expect(empty).toEqual([]);
		expect(harness.db.queries).toHaveLength(3);
		expect(harness.db.queries[1].text).toBe("UPDATE orders SET patient = ? , archived_at = NULL WHERE order_id = ?");
		expect(harness.db.queries[1].values).toEqual(["Jan", "o1"]);
	});

	test("DB.begin hands the transaction the same fake", async () =>
	{
		harness.db.queue([{ id: 1 }]);

		const rows = await DB.begin(async (sql) => sql`INSERT INTO t VALUES (${1}) RETURNING id`);

		expect(rows).toEqual([{ id: 1 }]);
		expect(harness.db.queries[0].values).toEqual([1]);
	});

	test("createS3Client returns the stub and reset clears it", async () =>
	{
		const s3 = await createS3Client();

		expect(s3).toBe(harness.s3);

		s3.seed("k", { body: "x" });

		expect(s3.objects.has("k")).toBe(true);

		harness.reset();

		expect(s3.objects.size).toBe(0);
	});

	test("callRoute sends plain objects as JSON with sec-fetch-site: same-origin", async () =>
	{
		let seen;

		await callRoute(async (req) =>
		{
			seen = { site: req.headers.get("sec-fetch-site"), type: req.headers.get("content-type"), body: await req.json() };

			return new Response(null);
		}, { method: "POST", url: "/x", body: { a: 1 } });

		expect(seen).toEqual({ site: "same-origin", type: "application/json", body: { a: 1 } });
	});
});
