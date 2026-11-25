import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { callRoute, harness, installRouteHarness, uninstallRouteHarness } from "./helpers/routeHarness.mjs";

// Run with `bun test --conditions react-server` so `server-only` resolves.
await installRouteHarness();

const { GET, POST, PUT, DELETE } = await import("../src/app/api/admin/orderingParties/route.js");
const { DELETE: DELETE_IDENTITY } = await import("../src/app/api/admin/deleteIdentity/route.js");
const { isUuid } = await import("../src/app/lib/validate.js");

const ADMIN_ID = "22222222-2222-4222-8222-222222222222";
const USER_ID = "11111111-1111-4111-8111-111111111111";
const PARTY_ID = "33333333-3333-4333-8333-333333333333";
const COLLECTION = "/api/admin/orderingParties";
const realFetch = globalThis.fetch;

const uniqueViolation = () => Object.assign(new Error("duplicate key value violates unique constraint"), { code: "23505" });

const send = (handler, { method = "GET", query = "", body } = {}) =>
	callRoute(handler, { method, url: `${COLLECTION}${query}`, body });

afterAll(() =>
{
	uninstallRouteHarness();
});

afterEach(() =>
{
	globalThis.fetch = realFetch;
});

beforeEach(() =>
{
	harness.reset();
	harness.session.loggedIn = true;
	harness.session.userId = ADMIN_ID;
	harness.session.role = "admin";
});

describe("admin ordering parties: access", () =>
{
	test("every method returns 403 for a non-admin and touches no rows", async () =>
	{
		harness.session.role = "user";

		const responses = [
			await send(GET, { query: `?userId=${USER_ID}` }),
			await send(POST, { method: "POST", body: { userId: USER_ID, name: "Alfa" } }),
			await send(PUT, { method: "PUT", body: { id: PARTY_ID, name: "Alfa" } }),
			await send(DELETE, { method: "DELETE", query: `?id=${PARTY_ID}` }),
		];

		for (const res of responses)
		{
			expect(res.status).toBe(403);
			expect(await res.json()).toEqual({ error: "Admin access required" });
		}
		expect(harness.db.queries).toEqual([]);
	});

	test("returns 403 when logged out", async () =>
	{
		harness.session.loggedIn = false;

		const res = await send(GET, { query: `?userId=${USER_ID}` });

		expect(res.status).toBe(403);
		expect(harness.db.queries).toEqual([]);
	});
});

describe("GET /api/admin/orderingParties", () =>
{
	test("returns the parties of the given account", async () =>
	{
		harness.db.queue([{ id: PARTY_ID, name: "Alfa" }]);

		const res = await send(GET, { query: `?userId=${USER_ID}` });

		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ orderingParties: [{ id: PARTY_ID, name: "Alfa" }] });
		expect(harness.db.queries[0].text).toContain("ORDER BY name");
		expect(harness.db.queries[0].values).toEqual([USER_ID]);
	});

	test("returns an empty list when the account has no parties", async () =>
	{
		const res = await send(GET, { query: `?userId=${USER_ID}` });

		expect(await res.json()).toEqual({ orderingParties: [] });
	});

	test("returns 400 for a missing or malformed userId", async () =>
	{
		for (const query of ["", "?userId=", `?userId=${USER_ID.slice(0, 10)}`])
		{
			const res = await send(GET, { query });

			expect(res.status).toBe(400);
			expect(await res.json()).toEqual({ error: "Nieprawidłowy identyfikator użytkownika." });
		}
		expect(harness.db.queries).toEqual([]);
	});
});

describe("POST /api/admin/orderingParties", () =>
{
	test("creates a party with a uuid7 id and returns 201", async () =>
	{
		const res = await send(POST, { method: "POST", body: { userId: USER_ID, name: "  Alfa  " } });
		const body = await res.json();

		expect(res.status).toBe(201);
		expect(isUuid(body.orderingParty.id)).toBe(true);
		expect(body.orderingParty).toEqual({ id: body.orderingParty.id, name: "Alfa" });
		expect(harness.db.queries[0].text).toContain("INSERT INTO ordering_parties");
		expect(harness.db.queries[0].values).toEqual([body.orderingParty.id, USER_ID, "Alfa"]);
	});

	test("accepts a name of exactly 200 characters", async () =>
	{
		const name = "a".repeat(200);
		const res = await send(POST, { method: "POST", body: { userId: USER_ID, name } });

		expect(res.status).toBe(201);
		expect((await res.json()).orderingParty.name).toBe(name);
	});

	test("returns 400 for a malformed userId and writes nothing", async () =>
	{
		const res = await send(POST, { method: "POST", body: { userId: "not-a-uuid", name: "Alfa" } });

		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({ error: "Nieprawidłowy identyfikator użytkownika." });
		expect(harness.db.queries).toEqual([]);
	});

	test("returns 400 for an empty name after trimming", async () =>
	{
		const res = await send(POST, { method: "POST", body: { userId: USER_ID, name: "   " } });

		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({ error: "Nazwa zleceniodawcy musi mieć od 1 do 200 znaków." });
		expect(harness.db.queries).toEqual([]);
	});

	test("returns 400 for a name longer than 200 characters", async () =>
	{
		const res = await send(POST, { method: "POST", body: { userId: USER_ID, name: "a".repeat(201) } });

		expect(res.status).toBe(400);
		expect(harness.db.queries).toEqual([]);
	});

	test("returns 400 for a body that is not JSON", async () =>
	{
		const res = await send(POST, { method: "POST", body: "{not json" });

		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({ error: "Nieprawidłowe dane formularza." });
	});

	test("returns 409 when the account already has a party with that name", async () =>
	{
		harness.db.queue(uniqueViolation());

		const res = await send(POST, { method: "POST", body: { userId: USER_ID, name: "Alfa" } });

		expect(res.status).toBe(409);
		expect(await res.json()).toEqual({ error: "Ten zleceniodawca już istnieje." });
	});

	test("returns 500 without leaking the database error", async () =>
	{
		harness.db.queue(Object.assign(new Error("connection terminated"), { code: "08006", detail: "Key (name)=(Alfa)" }));

		const res = await send(POST, { method: "POST", body: { userId: USER_ID, name: "Alfa" } });
		const text = await res.text();

		expect(res.status).toBe(500);
		expect(text).not.toContain("Alfa");
		expect(text).not.toContain("connection terminated");
	});
});

describe("PUT /api/admin/orderingParties", () =>
{
	test("renames the party and returns it", async () =>
	{
		harness.db.queue([{ id: PARTY_ID, name: "Beta" }]);

		const res = await send(PUT, { method: "PUT", body: { id: PARTY_ID, name: " Beta " } });

		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ orderingParty: { id: PARTY_ID, name: "Beta" } });
		expect(harness.db.queries[0].text).toContain("UPDATE ordering_parties");
		expect(harness.db.queries[0].values).toEqual(["Beta", PARTY_ID]);
	});

	test("returns 400 for a malformed id", async () =>
	{
		const res = await send(PUT, { method: "PUT", body: { id: "", name: "Beta" } });

		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({ error: "Nieprawidłowy identyfikator zleceniodawcy." });
		expect(harness.db.queries).toEqual([]);
	});

	test("returns 400 for an empty or too long name", async () =>
	{
		for (const name of ["", "   ", "b".repeat(201)])
		{
			const res = await send(PUT, { method: "PUT", body: { id: PARTY_ID, name } });

			expect(res.status).toBe(400);
		}
		expect(harness.db.queries).toEqual([]);
	});

	test("returns 404 for an unknown id", async () =>
	{
		harness.db.queue([]);

		const res = await send(PUT, { method: "PUT", body: { id: PARTY_ID, name: "Beta" } });

		expect(res.status).toBe(404);
		expect(await res.json()).toEqual({ error: "Nie znaleziono zleceniodawcy." });
	});

	test("returns 409 when renaming onto a name the account already uses", async () =>
	{
		harness.db.queue(uniqueViolation());

		const res = await send(PUT, { method: "PUT", body: { id: PARTY_ID, name: "Beta" } });

		expect(res.status).toBe(409);
		expect(await res.json()).toEqual({ error: "Ten zleceniodawca już istnieje." });
	});
});

describe("DELETE /api/admin/orderingParties", () =>
{
	test("deletes the party and returns success", async () =>
	{
		harness.db.queue([{ id: PARTY_ID }]);

		const res = await send(DELETE, { method: "DELETE", query: `?id=${PARTY_ID}` });

		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ success: true });
		expect(harness.db.queries[0].text).toContain("DELETE FROM ordering_parties");
		expect(harness.db.queries[0].values).toEqual([PARTY_ID]);
	});

	test("returns 400 for a missing or malformed id", async () =>
	{
		for (const query of ["", "?id=nope"])
		{
			const res = await send(DELETE, { method: "DELETE", query });

			expect(res.status).toBe(400);
		}
		expect(harness.db.queries).toEqual([]);
	});

	test("returns 404 for an unknown id", async () =>
	{
		harness.db.queue([]);

		const res = await send(DELETE, { method: "DELETE", query: `?id=${PARTY_ID}` });

		expect(res.status).toBe(404);
		expect(await res.json()).toEqual({ error: "Nie znaleziono zleceniodawcy." });
	});
});

describe("DELETE /api/admin/deleteIdentity cleanup", () =>
{
	test("removes the account's ordering parties after its user row", async () =>
	{
		globalThis.fetch = async () => new Response(null, { status: 204 });

		const res = await callRoute(DELETE_IDENTITY, { method: "DELETE", url: `/api/admin/deleteIdentity?id=${USER_ID}` });

		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ success: true });
		expect(harness.db.queries.map((query) => query.text)).toEqual([
			"DELETE FROM users WHERE user_id = ?",
			"DELETE FROM ordering_parties WHERE user_id = ?",
		]);
		expect(harness.db.queries[1].values).toEqual([USER_ID]);
	});
});
