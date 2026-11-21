// Link-header paging of listAllIdentities (Kratos admin API), with fetch replaced.
//
// Run with `bun test --conditions react-server` so `server-only` resolves.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

const { listAllIdentities, IdentityListError } = await import("../src/app/api/admin/listIdentities.js");

const ADMIN_URL = "http://kratos-admin.test:4434";
const realFetch = globalThis.fetch;

let requests;

function identities(prefix, count)
{
	return Array.from({ length: count }, (_, index) => ({ id: `${prefix}-${index}` }));
}

function page(body, { link, status = 200 } = {})
{
	return Response.json(body, { status, headers: link ? { Link: link } : {} });
}

// Serves the queued responses in order and records each request URL.
function installFetch(...responses)
{
	requests = [];

	globalThis.fetch = async (url, init) =>
	{
		requests.push({ url: new URL(String(url)), init });

		const next = responses.shift();

		if (next === undefined)
		{
			throw new Error("unexpected extra request");
		}

		return typeof next === "function" ? next() : next;
	};
}

beforeEach(() =>
{
	requests = [];
});

afterEach(() =>
{
	globalThis.fetch = realFetch;
});

describe("listAllIdentities", () =>
{
	test("a single page without a Link header is returned as is", async () =>
	{
		installFetch(page(identities("a", 3)));

		const result = await listAllIdentities({ adminUrl: ADMIN_URL, timeoutMs: 1000 });

		expect(result).toEqual({ identities: identities("a", 3), truncated: false });
		expect(requests).toHaveLength(1);
		expect(requests[0].url.origin + requests[0].url.pathname).toBe(`${ADMIN_URL}/admin/identities`);
		expect(requests[0].url.searchParams.get("page_size")).toBe("500");
		expect(requests[0].init.cache).toBe("no-store");
		expect(requests[0].init.headers).toEqual({ Accept: "application/json" });
	});

	test("follows rel=next links with page_token and concatenates the pages in order", async () =>
	{
		installFetch(
			page(identities("a", 2), { link: "<https://public.kratos.test/admin/identities?page_size=500&page_token=T2>; rel=\"next\"" }),
			page(identities("b", 2), { link: "<https://public.kratos.test/admin/identities?page_size=500&page_token=T3>; rel=\"next\", <https://public.kratos.test/admin/identities?page_token=T1>; rel=\"first\"" }),
			page(identities("c", 1), { link: "<https://public.kratos.test/admin/identities?page_token=T1>; rel=\"first\"" }),
		);

		const result = await listAllIdentities({ adminUrl: ADMIN_URL, timeoutMs: 1000 });

		expect(result.truncated).toBe(false);
		expect(result.identities.map((identity) => identity.id)).toEqual(["a-0", "a-1", "b-0", "b-1", "c-0"]);
		expect(requests.map((request) => request.url.searchParams.get("page_token"))).toEqual([null, "T2", "T3"]);
		// The host in the link is Kratos' public one; requests keep going to the admin URL.
		expect(requests.every((request) => request.url.origin === ADMIN_URL)).toBe(true);
		expect(requests[1].url.searchParams.get("page_size")).toBe("500");
	});

	test("accepts an unquoted rel and the legacy page parameter", async () =>
	{
		installFetch(
			page(identities("a", 1), { link: "</admin/identities?page=2&per_page=250>; rel=next" }),
			page(identities("b", 1)),
		);

		const result = await listAllIdentities({ adminUrl: ADMIN_URL, timeoutMs: 1000 });

		expect(result.identities.map((identity) => identity.id)).toEqual(["a-0", "b-0"]);
		expect(requests[1].url.searchParams.get("page")).toBe("2");
		expect(requests[1].url.searchParams.get("per_page")).toBe("250");
	});

	test("a next link without a page token or page ends the listing", async () =>
	{
		installFetch(page(identities("a", 2), { link: "</admin/identities?page_size=500>; rel=\"next\"" }));

		const result = await listAllIdentities({ adminUrl: ADMIN_URL, timeoutMs: 1000 });

		expect(result).toEqual({ identities: identities("a", 2), truncated: false });
		expect(requests).toHaveLength(1);
	});

	test("an empty page stops following next links", async () =>
	{
		installFetch(page([], { link: "</admin/identities?page_token=LOOP>; rel=\"next\"" }));

		const result = await listAllIdentities({ adminUrl: ADMIN_URL, timeoutMs: 1000 });

		expect(result).toEqual({ identities: [], truncated: false });
		expect(requests).toHaveLength(1);
	});

	test("stops after 50 pages and reports the result as truncated", async () =>
	{
		const endless = () => page(identities("x", 1), { link: "</admin/identities?page_token=AGAIN>; rel=\"next\"" });

		installFetch(...Array.from({ length: 60 }, () => endless));

		const result = await listAllIdentities({ adminUrl: ADMIN_URL, timeoutMs: 1000 });

		expect(result.truncated).toBe(true);
		expect(result.identities).toHaveLength(50);
		expect(requests).toHaveLength(50);
	});

	test.each([
		["a bare array", [{ id: "1" }]],
		["an identities property", { identities: [{ id: "1" }] }],
		["a data.identities property", { data: { identities: [{ id: "1" }] } }],
		["a data array", { data: [{ id: "1" }] }],
	])("reads identities from %s", async (_name, body) =>
	{
		installFetch(page(body));

		const result = await listAllIdentities({ adminUrl: ADMIN_URL, timeoutMs: 1000 });

		expect(result.identities).toEqual([{ id: "1" }]);
	});

	test("a non-2xx status throws IdentityListError with the status", async () =>
	{
		installFetch(page({ error: "boom" }, { status: 503 }));

		const error = await listAllIdentities({ adminUrl: ADMIN_URL, timeoutMs: 1000 }).then(() => null, (err) => err);

		expect(error).toBeInstanceOf(IdentityListError);
		expect(error.details).toEqual({ status: 503 });
		expect(error.message).toContain("503");
	});

	test("an error on a later page discards the earlier pages", async () =>
	{
		installFetch(
			page(identities("a", 1), { link: "</admin/identities?page_token=T2>; rel=\"next\"" }),
			page({}, { status: 500 }),
		);

		await expect(listAllIdentities({ adminUrl: ADMIN_URL, timeoutMs: 1000 })).rejects.toBeInstanceOf(IdentityListError);
	});

	test("an unexpected body throws IdentityListError listing only the payload keys", async () =>
	{
		installFetch(page({ message: "nope", secret: "s" }));

		const error = await listAllIdentities({ adminUrl: ADMIN_URL, timeoutMs: 1000 }).then(() => null, (err) => err);

		expect(error).toBeInstanceOf(IdentityListError);
		expect(error.details).toEqual({ status: 200, payloadKeys: ["message", "secret"] });
	});

	test("validates its arguments", async () =>
	{
		await expect(listAllIdentities({ adminUrl: "", timeoutMs: 1000 })).rejects.toThrow(TypeError);
		await expect(listAllIdentities({ adminUrl: ADMIN_URL, timeoutMs: 0 })).rejects.toThrow(RangeError);
		await expect(listAllIdentities({ adminUrl: ADMIN_URL, timeoutMs: Number.NaN })).rejects.toThrow(RangeError);
	});
});
