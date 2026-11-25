import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { inspect } from "node:util";
import { callRoute, harness, installRouteHarness, uninstallRouteHarness } from "./helpers/routeHarness.mjs";

// Run with `bun test --conditions react-server` so `server-only` resolves.
await installRouteHarness();

const { GET, POST, PUT, DELETE } = await import("../src/app/api/admin/orderingParties/route.js");
const { DELETE: DELETE_IDENTITY } = await import("../src/app/api/admin/deleteIdentity/route.js");
const { isUuid } = await import("../src/app/lib/validate.js");
const { KRATOS_TIMEOUT_MS } = await import("../src/app/lib/kratos.js");

const ADMIN_ID = "22222222-2222-4222-8222-222222222222";
const USER_ID = "11111111-1111-4111-8111-111111111111";
const PARTY_ID = "33333333-3333-4333-8333-333333333333";
const COLLECTION = "/api/admin/orderingParties";
const realFetch = globalThis.fetch;

const ADMIN_PARTY_ERROR = "Konta administratora nie mają zleceniodawców.";

// Stubs the Kratos admin lookup; `calls` records the requested URLs and `calls.signals` the abort signals.
// `rawBody` replaces the JSON body, `error` is thrown by the fetch (an abort or timeout).
function stubKratos(identity = { metadata_public: { role: "user" } }, { status = 200, fail = false, rawBody, error } = {})
{
	const calls = [];

	calls.signals = [];

	globalThis.fetch = async (url, init) =>
	{
		calls.push(String(url));
		calls.signals.push(init?.signal);

		if (error)
		{
			throw error;
		}

		if (fail)
		{
			throw new Error("connect ECONNREFUSED");
		}

		if (status !== 200)
		{
			return new Response(null, { status });
		}

		return rawBody === undefined ? Response.json(identity) : new Response(rawBody, { status: 200 });
	};

	return calls;
}

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
	stubKratos();
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
		harness.db.queue([{ user_id: USER_ID }], [{ id: PARTY_ID, name: "Beta" }]);

		const res = await send(PUT, { method: "PUT", body: { id: PARTY_ID, name: " Beta " } });

		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ orderingParty: { id: PARTY_ID, name: "Beta" } });
		expect(harness.db.queries[1].text).toContain("UPDATE ordering_parties");
		expect(harness.db.queries[1].values).toEqual(["Beta", PARTY_ID]);
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
		harness.db.queue([{ user_id: USER_ID }], uniqueViolation());

		const res = await send(PUT, { method: "PUT", body: { id: PARTY_ID, name: "Beta" } });

		expect(res.status).toBe(409);
		expect(await res.json()).toEqual({ error: "Ten zleceniodawca już istnieje." });
	});
});

describe("admin accounts cannot own ordering parties", () =>
{
	const ADMIN_TARGET = { metadata_public: { role: "admin" } };

	test("POST returns 403 for an admin target and writes nothing", async () =>
	{
		const calls = stubKratos(ADMIN_TARGET);

		const res = await send(POST, { method: "POST", body: { userId: USER_ID, name: "Alfa" } });

		expect(res.status).toBe(403);
		expect(await res.json()).toEqual({ error: ADMIN_PARTY_ERROR });
		expect(calls).toHaveLength(1);
		expect(calls[0]).toContain(`/admin/identities/${USER_ID}`);
		expect(harness.db.queries).toEqual([]);
	});

	test("POST still creates a party for a user target after the role check", async () =>
	{
		const calls = stubKratos({ metadata_public: { role: "user" } });

		const res = await send(POST, { method: "POST", body: { userId: USER_ID, name: "Alfa" } });

		expect(res.status).toBe(201);
		expect(calls).toHaveLength(1);
	});

	test("POST ignores a role that only appears in the user-editable traits", async () =>
	{
		stubKratos({ traits: { role: "admin" }, metadata_public: {} });

		const res = await send(POST, { method: "POST", body: { userId: USER_ID, name: "Alfa" } });

		expect(res.status).toBe(201);
	});

	test("POST validates input before calling Kratos", async () =>
	{
		const calls = stubKratos(ADMIN_TARGET);

		const res = await send(POST, { method: "POST", body: { userId: USER_ID, name: "  " } });

		expect(res.status).toBe(400);
		expect(calls).toEqual([]);
	});

	test("POST returns 404 when Kratos does not know the target", async () =>
	{
		stubKratos(undefined, { status: 404 });

		const res = await send(POST, { method: "POST", body: { userId: USER_ID, name: "Alfa" } });

		expect(res.status).toBe(404);
		expect(await res.json()).toEqual({ error: "Nie znaleziono użytkownika." });
		expect(harness.db.queries).toEqual([]);
	});

	test("POST fails closed with 502 when Kratos errors or is unreachable", async () =>
	{
		for (const options of [{ status: 500 }, { fail: true }])
		{
			harness.reset();
			harness.session.loggedIn = true;
			harness.session.role = "admin";
			stubKratos(undefined, options);

			const res = await send(POST, { method: "POST", body: { userId: USER_ID, name: "Alfa" } });

			expect(res.status).toBe(502);
			expect(await res.json()).toEqual({ error: "Nie udało się połączyć z Ory Kratos." });
			expect(harness.db.queries).toEqual([]);
		}
	});

	test("PUT returns 403 when the party belongs to an admin and updates nothing", async () =>
	{
		const calls = stubKratos(ADMIN_TARGET);

		harness.db.queue([{ user_id: USER_ID }]);

		const res = await send(PUT, { method: "PUT", body: { id: PARTY_ID, name: "Beta" } });

		expect(res.status).toBe(403);
		expect(await res.json()).toEqual({ error: ADMIN_PARTY_ERROR });
		expect(calls[0]).toContain(`/admin/identities/${USER_ID}`);
		expect(harness.db.queries).toHaveLength(1);
		expect(harness.db.queries[0].text).toContain("SELECT user_id");
	});

	test("PUT fails closed with 502 when Kratos is unreachable", async () =>
	{
		stubKratos(undefined, { fail: true });
		harness.db.queue([{ user_id: USER_ID }]);

		const res = await send(PUT, { method: "PUT", body: { id: PARTY_ID, name: "Beta" } });

		expect(res.status).toBe(502);
		expect(harness.db.queries).toHaveLength(1);
	});

	test("POST fails closed with 502 when Kratos returns a body that is not JSON", async () =>
	{
		stubKratos(undefined, { rawBody: "<html>bad gateway</html>" });

		const res = await send(POST, { method: "POST", body: { userId: USER_ID, name: "Alfa" } });

		expect(res.status).toBe(502);
		expect(await res.json()).toEqual({ error: "Nie udało się połączyć z Ory Kratos." });
		expect(harness.db.queries).toEqual([]);
	});

	test("POST fails closed with 502 when the Kratos request times out or is aborted", async () =>
	{
		for (const name of ["TimeoutError", "AbortError"])
		{
			harness.reset();
			harness.session.loggedIn = true;
			harness.session.role = "admin";

			const calls = stubKratos(undefined, { error: new DOMException("The operation timed out.", name) });
			const res = await send(POST, { method: "POST", body: { userId: USER_ID, name: "Alfa" } });

			expect(res.status).toBe(502);
			expect(await res.json()).toEqual({ error: "Nie udało się połączyć z Ory Kratos." });
			expect(calls).toHaveLength(1);
			expect(harness.db.queries).toEqual([]);
		}
	});

	test("the Kratos lookup is aborted by the configured timeout and fails closed with 502", async () =>
	{
		const signals = [];

		globalThis.fetch = (_url, init) =>
		{
			signals.push(init.signal);

			return new Promise((_resolve, reject) =>
			{
				init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
			});
		};

		const startedAt = performance.now();
		const res = await send(POST, { method: "POST", body: { userId: USER_ID, name: "Alfa" } });
		const elapsedMs = performance.now() - startedAt;

		expect(res.status).toBe(502);
		expect(await res.json()).toEqual({ error: "Nie udało się połączyć z Ory Kratos." });
		expect(signals).toHaveLength(1);
		expect(signals[0]).toBeInstanceOf(AbortSignal);
		expect(signals[0].aborted).toBe(true);
		expect(signals[0].reason.name).toBe("TimeoutError");
		expect(elapsedMs).toBeGreaterThanOrEqual(KRATOS_TIMEOUT_MS - 50);
		expect(harness.db.queries).toEqual([]);
	}, KRATOS_TIMEOUT_MS + 5000);

	test("POST with a malformed userId never reaches Kratos", async () =>
	{
		const calls = stubKratos(ADMIN_TARGET);

		for (const userId of ["not-a-uuid", "../admin/identities", "", undefined])
		{
			const res = await send(POST, { method: "POST", body: { userId, name: "Alfa" } });

			expect(res.status).toBe(400);
		}
		expect(calls).toEqual([]);
		expect(harness.db.queries).toEqual([]);
	});

	test("an unreadable Kratos body is logged without the body or the error object", async () =>
	{
		const MARKER = "SECRET-MARKER-BODY";
		const logged = [];
		const realConsole = { log: console.log, warn: console.warn, error: console.error };
		const capture = (...args) => logged.push(args);

		console.log = capture;
		console.warn = capture;
		console.error = capture;

		try
		{
			stubKratos(undefined, { rawBody: `${MARKER} <html>not json</html>` });

			const res = await send(POST, { method: "POST", body: { userId: USER_ID, name: "Alfa" } });

			expect(res.status).toBe(502);
		}
		finally
		{
			console.log = realConsole.log;
			console.warn = realConsole.warn;
			console.error = realConsole.error;
		}

		const errorLines = logged.filter((args) => typeof args[0] === "string" && args[0].startsWith("ERROR [admin]"));

		expect(errorLines.length).toBeGreaterThan(0);

		const allArgs = logged.flat();

		expect(allArgs.some((arg) => arg instanceof Error)).toBe(false);
		expect(allArgs.some((arg) => inspect(arg).includes(MARKER))).toBe(false);
	});

	test("PUT fails closed with 502 when Kratos returns a body that is not JSON", async () =>
	{
		stubKratos(undefined, { rawBody: "not json" });
		harness.db.queue([{ user_id: USER_ID }]);

		const res = await send(PUT, { method: "PUT", body: { id: PARTY_ID, name: "Beta" } });

		expect(res.status).toBe(502);
		expect(await res.json()).toEqual({ error: "Nie udało się połączyć z Ory Kratos." });
		expect(harness.db.queries).toHaveLength(1);
		expect(harness.db.queries[0].text).toContain("SELECT user_id");
	});

	test("PUT returns 404 when Kratos does not know the owner and updates nothing", async () =>
	{
		stubKratos(undefined, { status: 404 });
		harness.db.queue([{ user_id: USER_ID }]);

		const res = await send(PUT, { method: "PUT", body: { id: PARTY_ID, name: "Beta" } });

		expect(res.status).toBe(404);
		expect(await res.json()).toEqual({ error: "Nie znaleziono użytkownika." });
		expect(harness.db.queries).toHaveLength(1);
		expect(harness.db.queries[0].text).toContain("SELECT user_id");
	});

	test("PUT fails closed with 502 when the Kratos request times out", async () =>
	{
		stubKratos(undefined, { error: new DOMException("The operation timed out.", "TimeoutError") });
		harness.db.queue([{ user_id: USER_ID }]);

		const res = await send(PUT, { method: "PUT", body: { id: PARTY_ID, name: "Beta" } });

		expect(res.status).toBe(502);
		expect(harness.db.queries).toHaveLength(1);
	});

	test("PUT for an unknown party never calls Kratos", async () =>
	{
		const calls = stubKratos(ADMIN_TARGET);

		harness.db.queue([]);

		const res = await send(PUT, { method: "PUT", body: { id: PARTY_ID, name: "Beta" } });

		expect(res.status).toBe(404);
		expect(calls).toEqual([]);
		expect(harness.db.queries).toHaveLength(1);
	});

	test("PUT asks Kratos about the owner stored in the database, not an id from the request", async () =>
	{
		const OWNER_ID = "44444444-4444-4444-8444-444444444444";
		const calls = stubKratos();

		harness.db.queue([{ user_id: OWNER_ID }], [{ id: PARTY_ID, name: "Beta" }]);

		const res = await send(PUT, { method: "PUT", body: { id: PARTY_ID, userId: USER_ID, name: "Beta" } });

		expect(res.status).toBe(200);
		expect(calls).toHaveLength(1);
		expect(calls[0]).toContain(`/admin/identities/${encodeURIComponent(OWNER_ID)}`);
		expect(calls[0]).not.toContain(USER_ID);
	});

	test("PUT returns 404 when the party is deleted between the owner lookup and the update", async () =>
	{
		const calls = stubKratos();

		harness.db.queue([{ user_id: USER_ID }], []);

		const res = await send(PUT, { method: "PUT", body: { id: PARTY_ID, name: "Beta" } });

		expect(res.status).toBe(404);
		expect(await res.json()).toEqual({ error: "Nie znaleziono zleceniodawcy." });
		expect(calls).toHaveLength(1);
		expect(harness.db.queries).toHaveLength(2);
		expect(harness.db.queries[1].text).toContain("UPDATE ordering_parties");
	});

	test("DELETE of a stale row still works for an admin-owned party without asking Kratos", async () =>
	{
		const calls = stubKratos(ADMIN_TARGET);

		harness.db.queue([{ id: PARTY_ID }]);

		const res = await send(DELETE, { method: "DELETE", query: `?id=${PARTY_ID}` });

		expect(res.status).toBe(200);
		expect(calls).toEqual([]);
	});

	test("GET still lists stale rows of an admin target so they can be cleaned up", async () =>
	{
		const calls = stubKratos(ADMIN_TARGET);

		harness.db.queue([{ id: PARTY_ID, name: "Alfa" }]);

		const res = await send(GET, { query: `?userId=${USER_ID}` });

		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ orderingParties: [{ id: PARTY_ID, name: "Alfa" }] });
		expect(calls).toEqual([]);
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
