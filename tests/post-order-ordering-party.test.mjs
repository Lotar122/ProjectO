// POST /api/postOrder with an optional ordering party. The fake DB does not run
// SQL, so each test queues what Postgres would answer for the ownership lookup
// (the party row for its owner, or nothing for anyone else) and checks the
// INSERT that follows.

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { callRoute, harness, installRouteHarness, uninstallRouteHarness } from "./helpers/routeHarness.mjs";

// Run with `bun test --conditions react-server` so `server-only` resolves.
await installRouteHarness();

const { POST } = await import("../src/app/api/postOrder/route.js");

const USER_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PARTY_OF_A = "0190b2a4-1111-7000-8000-0000000000a1";
const PARTY_OF_B = "0190b2a4-2222-7000-8000-0000000000b2";

afterAll(() =>
{
	uninstallRouteHarness();
});

beforeEach(() =>
{
	harness.reset();
	harness.session.loggedIn = true;
	harness.session.userId = USER_A;
});

function orderForm(extra = {})
{
	const form = new FormData();

	form.append("patient", "Jan Kowalski");
	form.append("details", "Korona 11");
	form.append("dueDate", "2026-12-01");

	for (const [name, value] of Object.entries(extra))
	{
		form.append(name, value);
	}

	return form;
}

const callPost = (form) => callRoute(POST, { method: "POST", url: "/api/postOrder", body: form });

const insertQueries = () => harness.db.queries.filter((query) => /^INSERT INTO orders/.test(query.text));
const ownershipQueries = () => harness.db.queries.filter((query) => /FROM ordering_parties/.test(query.text));

describe("POST /api/postOrder ordering party", () =>
{
	test("a party owned by someone else is answered with 400 and the uploaded files are removed", async () =>
	{
		harness.db.queue([]);

		const form = orderForm({ orderingPartyId: PARTY_OF_B });
		form.append("files", new File(["scan"], "scan.stl"));

		const response = await callPost(form);
		const body = await response.json();

		expect(response.status).toBe(400);
		expect(body.success).toBe(false);
		expect(body.error).toBe("Nieprawidłowy zleceniodawca");

		expect(ownershipQueries()).toHaveLength(1);
		expect(ownershipQueries()[0].values).toContain(USER_A);
		expect(insertQueries()).toHaveLength(0);

		expect(harness.s3.started.length).toBe(1);
		expect(harness.s3.deleted).toEqual(harness.s3.started);
	});

	test("an empty ordering party stores NULL for both columns and does not look anything up", async () =>
	{
		const response = await callPost(orderForm({ orderingPartyId: "" }));

		expect(response.status).toBe(200);
		expect(ownershipQueries()).toHaveLength(0);

		const [insert] = insertQueries();

		expect(insert.values.slice(-2)).toEqual([null, null]);
	});

	test("a missing ordering party stores NULL for both columns", async () =>
	{
		const response = await callPost(orderForm());

		expect(response.status).toBe(200);
		expect(insertQueries()[0].values.slice(-2)).toEqual([null, null]);
	});

	test("a valid owned party stores its id and the name read from the database", async () =>
	{
		harness.db.queue([{ id: PARTY_OF_A, name: "Kancelaria Zielona" }]);

		const response = await callPost(orderForm({
			orderingPartyId: PARTY_OF_A,
			orderingPartyName: "Client-supplied name",
		}));

		expect(response.status).toBe(200);

		const [insert] = insertQueries();

		expect(insert.values.slice(-2)).toEqual([PARTY_OF_A, "Kancelaria Zielona"]);
	});

	test("a party id that is not a UUID is rejected before any file is stored or any query runs", async () =>
	{
		const form = orderForm({ orderingPartyId: "not-a-uuid" });
		form.append("files", new File(["scan"], "scan.stl"));

		const response = await callPost(form);
		const body = await response.json();

		expect(response.status).toBe(400);
		expect(body.code).toBe("INVALID_UPLOAD");
		expect(harness.s3.started).toHaveLength(0);
		expect(harness.db.queries).toHaveLength(0);
	});
});
