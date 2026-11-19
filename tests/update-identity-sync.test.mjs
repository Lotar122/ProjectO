import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { callRoute, harness, installRouteHarness, uninstallRouteHarness } from "./helpers/routeHarness.mjs";

// Run with `bun test --conditions react-server` so `server-only` resolves.
await installRouteHarness();

const { PUT } = await import("../src/app/api/admin/updateIdentity/route.js");
const { KRATOS_ADMIN_URL } = await import("../src/app/lib/kratosServer.js");

const TARGET_ID = "11111111-1111-4111-8111-111111111111";
const ADMIN_ID = "22222222-2222-4222-8222-222222222222";
const realFetch = globalThis.fetch;

let fetchCalls;
let errorLines;
const realConsoleError = console.error;

function kratosIdentity(email, name)
{
	return {
		id: TARGET_ID,
		schema_id: "default",
		state: "active",
		traits: name === undefined ? { email } : { email, name },
		metadata_public: { role: "user" },
	};
}

// What Kratos answers can differ from what the admin typed (it normalizes
// traits), so the PUT response is configurable and the users row must follow it.
function installKratosFetch({ lookupStatus = 200, putStatus = 200, putIdentity } = {})
{
	fetchCalls = [];

	globalThis.fetch = async (url, init = {}) =>
	{
		const method = init.method ?? "GET";

		fetchCalls.push({ url: String(url), method, body: init.body ? JSON.parse(init.body) : undefined });

		if (method === "PUT")
		{
			return putStatus === 200
				? Response.json(putIdentity ?? kratosIdentity("kratos@example.com", { first: "Zofia", last: "Wisniewska" }))
				: Response.json({ error: { reason: "rejected" } }, { status: putStatus });
		}

		return lookupStatus === 200
			? Response.json(kratosIdentity("old@example.com", { first: "Jan", last: "Kowalski" }))
			: Response.json({ error: { message: "lookup failed" } }, { status: lookupStatus });
	};
}

function updateRequest(overrides = {})
{
	return callRoute(PUT, {
		method: "PUT",
		url: "/api/admin/updateIdentity",
		body: { id: TARGET_ID, email: "Typed@Example.com", firstName: "Anna", lastName: "Nowak", role: "user", ...overrides },
	});
}

beforeEach(() =>
{
	harness.reset();
	harness.session.loggedIn = true;
	harness.session.userId = ADMIN_ID;
	harness.session.role = "admin";
	errorLines = [];
	console.error = (...args) => errorLines.push(args.join(" "));
	installKratosFetch();
});

afterEach(() =>
{
	globalThis.fetch = realFetch;
	console.error = realConsoleError;
});

afterAll(() =>
{
	uninstallRouteHarness();
});

describe("PUT /api/admin/updateIdentity users row sync", () =>
{
	test("writes the values Kratos returned, not the ones the admin typed", async () =>
	{
		const res = await updateRequest();

		expect(res.status).toBe(200);
		expect((await res.json()).identity.traits).toMatchObject({
			email: "kratos@example.com",
			name: { first: "Zofia", last: "Wisniewska" },
		});

		expect(fetchCalls.map((call) => call.method)).toEqual(["GET", "PUT"]);
		expect(fetchCalls.every((call) => call.url === `${KRATOS_ADMIN_URL}/admin/identities/${TARGET_ID}`)).toBe(true);
		// What the admin typed is what was sent to Kratos (email lower-cased by the route).
		expect(fetchCalls[1].body.traits).toMatchObject({ email: "typed@example.com", name: { first: "Anna", last: "Nowak" } });

		expect(harness.db.queries).toHaveLength(1);
		const [query] = harness.db.queries;

		expect(query.text).toContain("UPDATE users");
		expect(query.text).toContain("WHERE user_id = ?");
		expect(query.values).toEqual(["kratos@example.com", "Zofia", "Wisniewska", TARGET_ID]);
	});

	test("clears the names in users when Kratos returns none", async () =>
	{
		installKratosFetch({ putIdentity: kratosIdentity("kratos@example.com") });

		const res = await updateRequest({ firstName: "", lastName: "" });

		expect(res.status).toBe(200);
		expect(fetchCalls[1].body.traits.name).toBeUndefined();
		expect(harness.db.queries).toHaveLength(1);
		expect(harness.db.queries[0].values).toEqual(["kratos@example.com", null, null, TARGET_ID]);
	});

	test("still returns 200 when the users update fails, without logging PII", async () =>
	{
		harness.db.queue(Object.assign(new Error("duplicate key value violates unique constraint \"users_email_key\""), {
			code: "23505",
			constraint_name: "users_email_key",
			detail: "Key (email)=(kratos@example.com) already exists.",
		}));

		const res = await updateRequest();

		expect(res.status).toBe(200);
		expect((await res.json()).identity.traits.name).toEqual({ first: "Zofia", last: "Wisniewska" });

		const line = errorLines.find((entry) => entry.includes("Failed to sync users row"));

		expect(line).toContain("23505");
		expect(line).toContain("users_email_key");
		expect(errorLines.join(" ")).not.toContain("kratos@example.com");
	});

	test("does not touch users when Kratos rejects the update", async () =>
	{
		installKratosFetch({ putStatus: 422 });

		const res = await updateRequest();

		expect(res.status).toBe(422);
		expect(harness.db.queries).toEqual([]);
	});
});

describe("PUT /api/admin/updateIdentity Kratos lookup errors", () =>
{
	test("maps a 404 lookup to 404", async () =>
	{
		installKratosFetch({ lookupStatus: 404 });

		const res = await updateRequest();

		expect(res.status).toBe(404);
		expect((await res.json()).error).toBe("Nie znaleziono użytkownika.");
		expect(fetchCalls.map((call) => call.method)).toEqual(["GET"]);
		expect(harness.db.queries).toEqual([]);
	});

	test.each([500, 503])("maps a %d lookup to 502", async (lookupStatus) =>
	{
		installKratosFetch({ lookupStatus });

		const res = await updateRequest();

		expect(res.status).toBe(502);
		expect((await res.json()).error).toBe("Nie udało się połączyć z Ory Kratos.");
		expect(fetchCalls.map((call) => call.method)).toEqual(["GET"]);
		expect(harness.db.queries).toEqual([]);
	});

	test("maps a lookup that throws (Kratos unreachable, timeout) to 502", async () =>
	{
		globalThis.fetch = async (url, init = {}) =>
		{
			fetchCalls.push({ url: String(url), method: init.method ?? "GET" });

			throw new TypeError("fetch failed");
		};

		const res = await updateRequest();

		expect(res.status).toBe(502);
		expect((await res.json()).error).toBe("Nie udało się połączyć z Ory Kratos.");
		expect(fetchCalls.map((call) => call.method)).toEqual(["GET"]);
		expect(harness.db.queries).toEqual([]);
	});

	test("cancels the unread body of a failed lookup", async () =>
	{
		let cancelled = false;

		globalThis.fetch = async () => new Response(new ReadableStream({
			pull(controller)
			{
				controller.enqueue(new TextEncoder().encode("{}"));
			},
			cancel()
			{
				cancelled = true;
			},
		}), { status: 503 });

		const res = await updateRequest();

		expect(res.status).toBe(502);
		expect(cancelled).toBe(true);
	});
});
