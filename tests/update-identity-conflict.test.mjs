// Optimistic concurrency of PUT /api/admin/updateIdentity: a stale `updatedAt`
// is answered with 409 and nothing is written to Kratos or the users table.
//
// Run with `bun test --conditions react-server` so `server-only` resolves.

import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { callRoute, harness, installRouteHarness, uninstallRouteHarness } from "./helpers/routeHarness.mjs";

await installRouteHarness();

const { PUT } = await import("../src/app/api/admin/updateIdentity/route.js");

const TARGET_ID = "11111111-1111-4111-8111-111111111111";
const ADMIN_ID = "22222222-2222-4222-8222-222222222222";
const CURRENT_UPDATED_AT = "2026-11-20T10:00:00.000000Z";
const STALE_UPDATED_AT = "2026-11-19T08:30:00.000000Z";
const realFetch = globalThis.fetch;
const realWarn = console.warn;

let fetchCalls;
let warnLines;

function kratosIdentity()
{
	return {
		id: TARGET_ID,
		schema_id: "default",
		state: "active",
		traits: { email: "old@example.com", name: { first: "Jan", last: "Kowalski" } },
		metadata_public: { role: "user" },
		updated_at: CURRENT_UPDATED_AT,
	};
}

function installKratosFetch()
{
	fetchCalls = [];

	globalThis.fetch = async (url, init = {}) =>
	{
		const method = init.method ?? "GET";

		fetchCalls.push({ url: String(url), method });

		// The PUT answer carries the new timestamp; the lookup the one the form is compared with.
		return Response.json(method === "PUT"
			? { ...kratosIdentity(), updated_at: "2026-11-20T10:00:05.000000Z" }
			: kratosIdentity());
	};
}

function updateRequest(overrides = {})
{
	return callRoute(PUT, {
		method: "PUT",
		url: "/api/admin/updateIdentity",
		body: { id: TARGET_ID, email: "new@example.com", firstName: "Anna", lastName: "Nowak", role: "user", ...overrides },
	});
}

beforeEach(() =>
{
	harness.reset();
	harness.session.loggedIn = true;
	harness.session.userId = ADMIN_ID;
	harness.session.role = "admin";
	warnLines = [];
	console.warn = (...args) => warnLines.push(args.map(String).join(" "));
	installKratosFetch();
});

afterEach(() =>
{
	globalThis.fetch = realFetch;
	console.warn = realWarn;
});

afterAll(() =>
{
	uninstallRouteHarness();
});

describe("PUT /api/admin/updateIdentity stale updatedAt", () =>
{
	test("answers 409 and writes nothing when the identity changed since the form was loaded", async () =>
	{
		const res = await updateRequest({ updatedAt: STALE_UPDATED_AT });

		expect(res.status).toBe(409);
		expect((await res.json()).error).toContain("zmieniony");
		expect(fetchCalls.map((call) => call.method)).toEqual(["GET"]);
		expect(harness.db.queries).toEqual([]);
		expect(warnLines.some((line) => line.includes(TARGET_ID) && line.includes("changed since"))).toBe(true);
	});

	test("does not revoke sessions or change the password of a conflicting update", async () =>
	{
		const res = await updateRequest({ updatedAt: STALE_UPDATED_AT, password: "new-password-1" });

		expect(res.status).toBe(409);
		expect(fetchCalls.map((call) => call.method)).toEqual(["GET"]);
	});

	test("saves when updatedAt matches what Kratos holds now", async () =>
	{
		const res = await updateRequest({ updatedAt: CURRENT_UPDATED_AT });

		expect(res.status).toBe(200);
		expect(fetchCalls.map((call) => call.method)).toEqual(["GET", "PUT"]);
		expect(harness.db.queries).toHaveLength(1);
	});

	test.each([
		["absent", undefined],
		["empty", ""],
		["not a string", 12345],
		["null", null],
	])("a client that sends updatedAt %s is not checked", async (_name, updatedAt) =>
	{
		const res = await updateRequest({ updatedAt });

		expect(res.status).toBe(200);
		expect(fetchCalls.map((call) => call.method)).toEqual(["GET", "PUT"]);
	});

	test("the comparison is exact: a differently formatted timestamp is a conflict", async () =>
	{
		const res = await updateRequest({ updatedAt: "2026-11-20T10:00:00Z" });

		expect(res.status).toBe(409);
	});

	test("input validation still comes before the conflict check", async () =>
	{
		const res = await updateRequest({ updatedAt: STALE_UPDATED_AT, email: "not-an-email" });

		expect(res.status).toBe(400);
		expect(fetchCalls).toEqual([]);
	});

	test("an admin who demotes themselves gets 400 before the conflict check", async () =>
	{
		const res = await updateRequest({ id: ADMIN_ID, role: "user", updatedAt: STALE_UPDATED_AT });

		expect(res.status).toBe(400);
		expect(fetchCalls.map((call) => call.method)).toEqual(["GET"]);
	});
});
