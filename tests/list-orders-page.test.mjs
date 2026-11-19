import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { harness, installRouteHarness, uninstallRouteHarness } from "./helpers/routeHarness.mjs";

// Run with `bun test --conditions react-server` so `server-only` resolves.
await installRouteHarness();

const { listOrders, MAX_PAGE, ORDERS_PAGE_SIZE } = await import("../src/app/server-functions/orders/listOrders.js");

beforeEach(() =>
{
	harness.reset();
});

afterAll(() =>
{
	uninstallRouteHarness();
});

const offsetOf = (query) => query.values.at(-1);

describe("listOrders page clamp", () =>
{
	test.each([
		["99999999999999999999"],
		["100000000000000000000000000"],
		[String(Number.MAX_SAFE_INTEGER)],
		[String(MAX_PAGE + 1)],
	])("page %s is clamped to MAX_PAGE before the OFFSET is built", async (page) =>
	{
		// 30 orders -> 2 pages, so the over-long first read is redone for the last page.
		harness.db.queue([{ total: 30 }], [], [{ order_id: "last" }]);

		const result = await listOrders({ userId: "user-1", page });

		const [, firstFetch, secondFetch] = harness.db.queries;

		expect(offsetOf(firstFetch)).toBe((MAX_PAGE - 1) * ORDERS_PAGE_SIZE);
		expect(offsetOf(firstFetch)).toBeLessThan(MAX_PAGE * ORDERS_PAGE_SIZE);
		expect(offsetOf(secondFetch)).toBe(ORDERS_PAGE_SIZE);
		expect(result.page).toBe(2);
		expect(result.totalPages).toBe(2);
		expect(result.orders).toEqual([{ order_id: "last" }]);
	});

	test("a scientific-notation page is read as its leading digits, never as 1e30", async () =>
	{
		harness.db.queue([{ total: 100 }], [{ order_id: "first" }]);

		const result = await listOrders({ userId: "user-1", page: "1e30" });

		expect(offsetOf(harness.db.queries[1])).toBe(0);
		expect(result.page).toBe(1);
	});

	test.each([[undefined], ["0"], ["-3"], ["abc"]])("page %j falls back to the first page", async (page) =>
	{
		harness.db.queue([{ total: 100 }], [{ order_id: "first" }]);

		const result = await listOrders({ userId: "user-1", page });

		expect(offsetOf(harness.db.queries[1])).toBe(0);
		expect(result.page).toBe(1);
	});
});
