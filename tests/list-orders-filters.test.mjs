import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { harness, installRouteHarness, uninstallRouteHarness } from "./helpers/routeHarness.mjs";

// Run with `bun test --conditions react-server` so `server-only` resolves.
await installRouteHarness();

const { listOrders, InvalidOrderFilterError, ORDERS_PAGE_SIZE } = await import("../src/app/server-functions/orders/listOrders.js");
const { MAX_SEARCH_LENGTH } = await import("../src/app/lib/validate.js");

beforeEach(() =>
{
	harness.reset();
});

afterAll(() =>
{
	uninstallRouteHarness();
});

const USER_ID = "11111111-1111-4111-8111-111111111111";

// The page clamp lives in list-orders-page.test.mjs. Here: one empty list per call.
async function list(options)
{
	harness.db.queue([{ total: 0 }], []);

	await listOrders(options);

	const [count, fetch] = harness.db.queries;

	return { count, fetch };
}

describe("listOrders owner filter", () =>
{
	test("an owner list is limited to that user's orders", async () =>
	{
		const { count, fetch } = await list({ userId: USER_ID });

		expect(fetch.text).toContain("AND orders.user_id = ?");
		expect(fetch.values).toContain(USER_ID);
		expect(count.text).toContain("AND orders.user_id = ?");
		expect(count.values).toEqual([USER_ID]);
	});

	test("the owner list does not join users or select owner columns", async () =>
	{
		const { fetch } = await list({ userId: USER_ID });

		expect(fetch.text).not.toContain("JOIN users");
		expect(fetch.text).not.toContain("owner_email");
	});

	test("the admin list (userId null) has no owner filter and shows the owner's name", async () =>
	{
		const { count, fetch } = await list({ userId: null });

		expect(fetch.text).not.toContain("orders.user_id = ?");
		expect(count.text).not.toContain("orders.user_id = ?");
		expect(fetch.text).toContain("LEFT JOIN users ON users.user_id = orders.user_id");
		expect(fetch.text).toContain("users.email AS owner_email");
		expect(fetch.values).not.toContain(USER_ID);
	});

	test("the admin count joins users only when a search needs its columns", async () =>
	{
		const withoutSearch = await list({ userId: null });

		expect(withoutSearch.count.text).not.toContain("JOIN users");

		harness.reset();

		const withSearch = await list({ userId: null, search: "kowalski" });

		expect(withSearch.count.text).toContain("LEFT JOIN users");
		expect(withSearch.count.text).toContain("users.last_name ILIKE ?");
	});

	test("an owner search covers the patient only; an admin search also covers the owner", async () =>
	{
		const owner = await list({ userId: USER_ID, search: "jan" });

		expect(owner.fetch.text).toContain("AND orders.patient ILIKE ?");
		expect(owner.fetch.text).not.toContain("users.");

		harness.reset();

		const admin = await list({ userId: null, search: "jan" });

		expect(admin.fetch.text).toContain("orders.patient ILIKE ?");
		expect(admin.fetch.text).toContain("users.email ILIKE ?");
	});
});

describe("listOrders status filter", () =>
{
	test.each([
		["pending", "pending"],
		["In Progress", "in-progress"],
		["  SHIPPED ", "shipped"],
		["completed", "completed"],
	])("status %j is normalized to %s", async (input, expected) =>
	{
		const { fetch, count } = await list({ userId: USER_ID, status: input });

		expect(fetch.text).toContain("AND orders.status = ?");
		expect(fetch.values).toContain(expected);
		expect(count.values).toContain(expected);
	});

	test.each([undefined, null, "", "   "])("an empty status %j adds no status filter", async (status) =>
	{
		const { fetch } = await list({ userId: USER_ID, status });

		expect(fetch.text).not.toContain("orders.status");
	});

	test.each(["Gotowe", "w trakcie", "cancelled", "pending; DROP TABLE orders"])("unknown status %j throws before any query", async (status) =>
	{
		await expect(listOrders({ userId: USER_ID, status })).rejects.toBeInstanceOf(InvalidOrderFilterError);
		expect(harness.db.queries).toEqual([]);
	});

	test("the error says what was wrong", async () =>
	{
		await expect(listOrders({ userId: USER_ID, status: "Gotowe" })).rejects.toThrow("Unknown status");
	});
});

describe("listOrders search", () =>
{
	test("a search of MAX_SEARCH_LENGTH characters is accepted", async () =>
	{
		const { fetch } = await list({ userId: USER_ID, search: "a".repeat(MAX_SEARCH_LENGTH) });

		expect(fetch.values).toContain(`%${"a".repeat(MAX_SEARCH_LENGTH)}%`);
	});

	test("a search over MAX_SEARCH_LENGTH characters throws before any query", async () =>
	{
		const search = "a".repeat(MAX_SEARCH_LENGTH + 1);

		await expect(listOrders({ userId: USER_ID, search })).rejects.toBeInstanceOf(InvalidOrderFilterError);
		await expect(listOrders({ userId: USER_ID, search })).rejects.toThrow("Search is too long");
		expect(harness.db.queries).toEqual([]);
	});

	test("the length limit applies after trimming", async () =>
	{
		const search = `  ${"a".repeat(MAX_SEARCH_LENGTH)}  `;
		const { fetch } = await list({ userId: USER_ID, search });

		expect(fetch.values).toContain(`%${"a".repeat(MAX_SEARCH_LENGTH)}%`);
	});

	test("% and _ in the search are escaped so they match literally", async () =>
	{
		const { fetch } = await list({ userId: USER_ID, search: "50%_off" });

		expect(fetch.values).toContain("%50\\%\\_off%");
	});

	test("a backslash in the search is escaped too", async () =>
	{
		const { fetch } = await list({ userId: USER_ID, search: "a\\b" });

		expect(fetch.values).toContain("%a\\\\b%");
	});

	test("the search term is a bound value, never part of the SQL text", async () =>
	{
		const { fetch } = await list({ userId: USER_ID, search: "x'; DROP TABLE orders; --" });

		expect(fetch.text).not.toContain("DROP TABLE");
		expect(fetch.values).toContain("%x'; DROP TABLE orders; --%");
	});

	test("a blank search adds no filter", async () =>
	{
		const { fetch } = await list({ userId: USER_ID, search: "   " });

		expect(fetch.text).not.toContain("ILIKE");
	});
});

describe("listOrders page size", () =>
{
	test("limit is capped at the page size and falls back to it", async () =>
	{
		const capped = await list({ userId: USER_ID, limit: "1000" });

		expect(capped.fetch.values.at(-2)).toBe(ORDERS_PAGE_SIZE);

		harness.reset();

		const smaller = await list({ userId: USER_ID, limit: "5" });

		expect(smaller.fetch.values.at(-2)).toBe(5);
	});
});
