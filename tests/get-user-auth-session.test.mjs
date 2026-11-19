import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { harness, installRouteHarness, uninstallRouteHarness } from "./helpers/routeHarness.mjs";

// Run with `bun test --conditions react-server` so `server-only` resolves.
// The harness supplies the fake DB; the real getUserAuthSession is loaded
// under a query string so it is not the harness's mocked copy and starts with
// an empty once-per-identity warning set.
await installRouteHarness();

const { getUserAuthSession } = await import("../src/app/server-functions/getUserAuthSession.js?real-session");

const IDENTITY_ID = "33333333-3333-4333-8333-333333333333";
const realFetch = globalThis.fetch;
const realConsoleWarn = console.warn;
const realConsoleLog = console.log;
const realConsoleError = console.error;

let warnLines;
let infoLines;
let errorLines;

const cookieJarOf = (value) => ({ get: (name) => (name === "ory_kratos_session" ? { value } : undefined) });
const cookieJar = cookieJarOf("session-token");

function whoami(identityId = IDENTITY_ID, traits = { email: "user@example.com", name: { first: "Anna", last: "Nowak" } })
{
	return {
		active: true,
		identity: {
			id: identityId,
			traits,
		},
	};
}

function uniqueViolation()
{
	return Object.assign(new Error("duplicate key value violates unique constraint"), {
		code: "23505",
		constraint_name: "users_email_key",
		detail: "Key (email)=(user@example.com) already exists.",
	});
}

beforeEach(() =>
{
	harness.reset();
	warnLines = [];
	infoLines = [];
	errorLines = [];
	console.warn = (...args) => warnLines.push(args.join(" "));
	console.log = (...args) => infoLines.push(args.join(" "));
	console.error = (...args) => errorLines.push(args.join(" "));
	globalThis.fetch = async () => Response.json(whoami());
});

afterEach(() =>
{
	globalThis.fetch = realFetch;
	console.warn = realConsoleWarn;
	console.log = realConsoleLog;
	console.error = realConsoleError;
});

afterAll(() =>
{
	uninstallRouteHarness();
});

describe("getUserAuthSession users row sync", () =>
{
	test("syncs in one lock-free statement that only writes when a value differs", async () =>
	{
		const session = await getUserAuthSession(cookieJar);

		expect(session.loggedIn).toBe(true);
		expect(harness.db.queries).toHaveLength(1);

		const { text, values } = harness.db.queries[0];

		expect(text).toContain("IS DISTINCT FROM");
		expect(text).toContain("WITH upd AS ( UPDATE users");
		expect(text).toContain("WHERE NOT EXISTS (SELECT 1 FROM users WHERE user_id = ?)");
		expect(text).toContain("ON CONFLICT (user_id) DO NOTHING");
		// DO UPDATE .. WHERE <false> would still lock the row on every request.
		expect(text).not.toContain("DO UPDATE");
		expect(values.filter((value) => value === IDENTITY_ID)).toHaveLength(3);
		expect(values.filter((value) => value === "user@example.com")).toHaveLength(3);
	});

	test("logs Created for an inserted row, Updated for a changed one, nothing when unchanged", async () =>
	{
		harness.db.queue([{ user_id: IDENTITY_ID, inserted: true }], [{ user_id: IDENTITY_ID, inserted: false }], []);

		await getUserAuthSession(cookieJar);
		await getUserAuthSession(cookieJar);
		await getUserAuthSession(cookieJar);

		const lines = infoLines.filter((line) => line.includes("user row"));

		expect(lines).toHaveLength(2);
		expect(lines[0]).toContain("Created user row");
		expect(lines[1]).toContain("Updated user row");
	});

	test("keeps the session valid on a unique violation and warns once per identity", async () =>
	{
		harness.db.queue(uniqueViolation(), uniqueViolation());

		const first = await getUserAuthSession(cookieJar);
		const second = await getUserAuthSession(cookieJar);

		expect(first.loggedIn).toBe(true);
		expect(second.loggedIn).toBe(true);
		expect(harness.db.queries).toHaveLength(2);

		const warnings = warnLines.filter((line) => line.includes(IDENTITY_ID));

		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("unique constraint");
		expect(errorLines).toEqual([]);
	});

	test("still logs other database errors as errors", async () =>
	{
		harness.db.queue(new Error("connection terminated"));

		const session = await getUserAuthSession(cookieJar);

		expect(session.loggedIn).toBe(true);
		expect(errorLines.some((line) => line.includes("Failed to sync user row"))).toBe(true);
		expect(warnLines).toEqual([]);
	});

	test("does not put the email or other detail of a database error in the log", async () =>
	{
		// The warning is once per identity per process, so use one no other test warns for.
		globalThis.fetch = async () => Response.json(whoami("44444444-4444-4444-8444-444444444444"));
		harness.db.queue(uniqueViolation());

		await getUserAuthSession(cookieJar);

		const everything = [...warnLines, ...errorLines, ...infoLines].join(" ");

		expect(everything).toContain("users_email_key");
		expect(everything).not.toContain("user@example.com");
	});

	test("skips the sync, keeping the session, when the identity has no email", async () =>
	{
		globalThis.fetch = async () => Response.json(whoami(IDENTITY_ID, { name: { first: "Anna", last: "Nowak" } }));

		const session = await getUserAuthSession(cookieJar);

		expect(session.loggedIn).toBe(true);
		expect(harness.db.queries).toEqual([]);
		expect(errorLines).toEqual([]);
	});
});

describe("getUserAuthSession cookie validation", () =>
{
	test.each([
		["a\r\nb", "CR and LF"],
		["tokén", "non-ASCII"],
		["a b", "a space"],
		["", "an empty value"],
		["a".repeat(4097), "an over-long value"],
	])("treats %j (%s) as logged out without asking Kratos", async (value) =>
	{
		let fetchCalls = 0;

		globalThis.fetch = async () =>
		{
			fetchCalls++;

			return Response.json(whoami());
		};

		const session = await getUserAuthSession(cookieJarOf(value));

		expect(session).toEqual({ loggedIn: false, data: null });
		expect(fetchCalls).toBe(0);
		expect(harness.db.queries).toEqual([]);
	});

	test("still sends a well-formed Kratos cookie", async () =>
	{
		let sentCookie;

		globalThis.fetch = async (url, init) =>
		{
			sentCookie = init.headers.Cookie;

			return Response.json(whoami());
		};

		const session = await getUserAuthSession(cookieJarOf("MTc2.abc_DEF-ghi~+/="));

		expect(session.loggedIn).toBe(true);
		expect(sentCookie).toBe("ory_kratos_session=MTc2.abc_DEF-ghi~+/=");
	});
});
