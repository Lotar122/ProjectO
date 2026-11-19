import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Readable } from "node:stream";
import { harness, installRouteHarness, uninstallRouteHarness } from "./helpers/routeHarness.mjs";

// Run with `bun test --conditions react-server` so `server-only` resolves.
await installRouteHarness();

const { GET } = await import("../src/app/api/downloadFile/route.js");

const FILE_ID = "55555555-5555-4555-8555-555555555555";
const originalSend = harness.s3.send;

let s3Body;

// Resolves once pending pipeline() teardown (which runs on later ticks) has happened.
const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

beforeEach(() =>
{
	harness.reset();
	harness.session.loggedIn = true;
	harness.session.userId = "user-1";
	harness.db.queue([{ file_id: FILE_ID }]);

	// A stream that never ends stands in for the open S3 connection.
	s3Body = new Readable({
		read()
		{}
	});
	harness.s3.send = async () => ({
		Body: s3Body,
		ContentLength: 10,
		ContentType: "application/octet-stream",
		Metadata: {},
	});
});

afterEach(() =>
{
	harness.s3.send = originalSend;
	s3Body.destroy();
});

afterAll(() =>
{
	uninstallRouteHarness();
});

describe("GET /api/downloadFile client disconnect", () =>
{
	test("answers 499 without logging an error when the client aborts while S3 is still answering", async () =>
	{
		const controller = new AbortController();
		const errorLines = [];
		const realConsoleError = console.error;

		harness.s3.send = async (command, options) =>
		{
			// The AWS SDK rejects with AbortError once the signal passed through getFile fires.
			expect(options.abortSignal).toBe(controller.signal);
			controller.abort();

			throw Object.assign(new Error("Request aborted"), { name: "AbortError" });
		};
		console.error = (...args) => errorLines.push(args.join(" "));

		try
		{
			const request = new Request(`http://localhost/api/downloadFile?file_id=${FILE_ID}`, {
				signal: controller.signal,
			});
			const res = await GET(request);

			expect(res.status).toBe(499);
			expect(res.body).toBeNull();
			expect(errorLines).toEqual([]);
		}
		finally
		{
			console.error = realConsoleError;
		}
	});

	test("still answers 500 when S3 fails while the client is connected", async () =>
	{
		const realConsoleError = console.error;

		harness.s3.send = async () =>
		{
			throw new Error("S3 down");
		};
		console.error = () =>
		{
		};

		try
		{
			const res = await GET(new Request(`http://localhost/api/downloadFile?file_id=${FILE_ID}`));

			expect(res.status).toBe(500);
		}
		finally
		{
			console.error = realConsoleError;
		}
	});

	test("destroys the S3 body and answers 499 when the request was already aborted", async () =>
	{
		const request = new Request(`http://localhost/api/downloadFile?file_id=${FILE_ID}`, {
			signal: AbortSignal.abort(),
		});

		const res = await GET(request);

		expect(res.status).toBe(499);
		expect(res.body).toBeNull();

		await settle();

		expect(s3Body.destroyed).toBe(true);
	});

	test("keeps streaming while the client is connected and destroys the body on a later abort", async () =>
	{
		const controller = new AbortController();
		const request = new Request(`http://localhost/api/downloadFile?file_id=${FILE_ID}`, {
			signal: controller.signal,
		});

		const res = await GET(request);

		expect(res.status).toBe(200);

		await settle();
		expect(s3Body.destroyed).toBe(false);

		controller.abort();
		await settle();

		expect(s3Body.destroyed).toBe(true);
	});
});
