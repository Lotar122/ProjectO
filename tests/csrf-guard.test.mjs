import { afterEach, beforeEach, describe, expect, test } from "bun:test";

// Run with `bun test --conditions react-server` so `server-only` resolves.
const { isCrossSiteWrite, withRequestLogging } = await import("../src/app/lib/withRequestLogging.js");

const realAllowedOrigins = process.env.ALLOWED_ORIGINS;

beforeEach(() =>
{
	delete process.env.ALLOWED_ORIGINS;
});

afterEach(() =>
{
	if (realAllowedOrigins === undefined)
	{
		delete process.env.ALLOWED_ORIGINS;
	}
	else
	{
		process.env.ALLOWED_ORIGINS = realAllowedOrigins;
	}
});

const makeRequest = (method, headers = {}) =>
	new Request("http://app.example/api/thing", { method, headers });

describe("isCrossSiteWrite safe methods", () =>
{
	test.each(["GET", "HEAD", "OPTIONS"])("%s always passes, even from another site", (method) =>
	{
		const request = makeRequest(method, { "sec-fetch-site": "cross-site", origin: "http://evil.example" });

		expect(isCrossSiteWrite(request)).toBe(false);
	});
});

describe("isCrossSiteWrite with Sec-Fetch-Site", () =>
{
	test.each(["same-origin", "none"])("%s passes", (site) =>
	{
		expect(isCrossSiteWrite(makeRequest("POST", { "sec-fetch-site": site }))).toBe(false);
	});

	test.each(["same-site", "cross-site"])("%s is blocked", (site) =>
	{
		expect(isCrossSiteWrite(makeRequest("POST", { "sec-fetch-site": site }))).toBe(true);
	});

	test("Sec-Fetch-Site wins over an Origin that looks fine", () =>
	{
		process.env.ALLOWED_ORIGINS = "http://evil.example";

		const request = makeRequest("PUT", { "sec-fetch-site": "cross-site", origin: "http://evil.example" });

		expect(isCrossSiteWrite(request)).toBe(true);
	});

	test.each(["POST", "PUT", "PATCH", "DELETE"])("%s is checked", (method) =>
	{
		expect(isCrossSiteWrite(makeRequest(method, { "sec-fetch-site": "cross-site" }))).toBe(true);
	});
});

describe("isCrossSiteWrite without Sec-Fetch-Site", () =>
{
	test("no Origin either: passes (non-browser client)", () =>
	{
		expect(isCrossSiteWrite(makeRequest("POST"))).toBe(false);
	});

	test("an Origin in the allow list passes", () =>
	{
		process.env.ALLOWED_ORIGINS = "http://other.example, https://panel.example";

		const request = makeRequest("POST", { origin: "https://panel.example", host: "app.example" });

		expect(isCrossSiteWrite(request)).toBe(false);
	});

	test("an Origin missing from the allow list is judged by host", () =>
	{
		process.env.ALLOWED_ORIGINS = "http://other.example";

		const request = makeRequest("POST", { origin: "http://evil.example", host: "app.example" });

		expect(isCrossSiteWrite(request)).toBe(true);
	});

	test("an Origin whose host equals Host passes", () =>
	{
		const request = makeRequest("POST", { origin: "http://app.example", host: "app.example" });

		expect(isCrossSiteWrite(request)).toBe(false);
	});

	test("an Origin whose host equals X-Forwarded-Host passes, and Host is then ignored", () =>
	{
		const request = makeRequest("POST", {
			origin: "https://public.example",
			"x-forwarded-host": "public.example",
			host: "internal:3000",
		});

		expect(isCrossSiteWrite(request)).toBe(false);
	});

	test("an Origin that differs from X-Forwarded-Host is blocked even if it equals Host", () =>
	{
		const request = makeRequest("POST", {
			origin: "http://internal:3000",
			"x-forwarded-host": "public.example",
			host: "internal:3000",
		});

		expect(isCrossSiteWrite(request)).toBe(true);
	});

	test("an Origin on another host is blocked", () =>
	{
		const request = makeRequest("DELETE", { origin: "http://evil.example", host: "app.example" });

		expect(isCrossSiteWrite(request)).toBe(true);
	});

	test("the same hostname on another port is blocked", () =>
	{
		const request = makeRequest("POST", { origin: "http://app.example:8080", host: "app.example" });

		expect(isCrossSiteWrite(request)).toBe(true);
	});

	test("an unparseable Origin is blocked", () =>
	{
		const request = makeRequest("POST", { origin: "not a url", host: "app.example" });

		expect(isCrossSiteWrite(request)).toBe(true);
	});

	test("the Origin 'null' (sandboxed iframe, redirects) is blocked", () =>
	{
		expect(isCrossSiteWrite(makeRequest("POST", { origin: "null", host: "app.example" }))).toBe(true);
	});
});

describe("withRequestLogging CSRF guard", () =>
{
	test("answers 403 and never runs the handler for a cross-site write", async () =>
	{
		let calls = 0;
		const handler = withRequestLogging(async () =>
		{
			calls++;

			return Response.json({ ok: true });
		});

		const res = await handler(makeRequest("POST", { "sec-fetch-site": "cross-site" }));

		expect(res.status).toBe(403);
		expect(await res.json()).toEqual({ error: "Forbidden" });
		expect(calls).toBe(0);
	});

	test("runs the handler for a same-origin write", async () =>
	{
		const handler = withRequestLogging(async () => Response.json({ ok: true }));

		const res = await handler(makeRequest("POST", { "sec-fetch-site": "same-origin" }));

		expect(res.status).toBe(200);
	});
});
