import { afterAll, afterEach, beforeEach, describe, expect, jest, test } from "bun:test";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import zlib from "node:zlib";
import { harness, installRouteHarness, uninstallRouteHarness } from "./helpers/routeHarness.mjs";

// Run with `bun test --conditions react-server` so `server-only` resolves.
await installRouteHarness();

const { GET } = await import("../src/app/api/downloadFile/route.js");
const { SemaphoreTimeoutError, createWeightedSemaphore } = await import("../src/app/lib/concurrency.js");
const {
	DEFAULT_DECODE_BUDGET_MIB,
	MIN_DECODE_BUDGET_MIB,
	decodeWeight,
	parseDecodeBudgetMiB,
} = await import("../src/app/server-functions/orders/downloadDecodeBudget.js");

const MiB = 1024 * 1024;
const FILE_ID = "66666666-6666-4666-8666-666666666666";
const originalSend = harness.s3.send;

// Lets pending pipeline() teardown and close events (which run on later ticks) happen.
const settle = () => new Promise((resolve) => setImmediate(resolve));
const isPending = async (promise) =>
{
	const pending = Symbol("pending");

	await settle();

	return (await Promise.race([promise, Promise.resolve(pending)])) === pending;
};

describe("decodeWeight", () =>
{
	test("matches the documented vectors", () =>
	{
		expect(decodeWeight("zstd", 250 * MiB)).toBe(266 * MiB);
		expect(decodeWeight("zstd", 1024)).toBe(16 * MiB + 1024);
		expect(decodeWeight("br", 250 * MiB)).toBe(272 * MiB);
		// 17 MiB needs a 2^25 window.
		expect(decodeWeight("br", 17 * MiB)).toBe(48 * MiB);
		// The smallest window is 2^10.
		expect(decodeWeight("br", 1024)).toBe(16 * MiB + 1024);
		expect(decodeWeight("zstd", undefined)).toBe(272 * MiB);
		expect(decodeWeight("br", undefined)).toBe(272 * MiB);
	});

	test("caps zstd at the window limit and treats invalid sizes as the maximum", () =>
	{
		expect(decodeWeight("zstd", 4096 * MiB)).toBe(272 * MiB);
		expect(decodeWeight("br", 4096 * MiB)).toBe(272 * MiB);
		expect(decodeWeight("zstd", -1)).toBe(272 * MiB);
		expect(decodeWeight("zstd", Number.NaN)).toBe(272 * MiB);
		expect(decodeWeight("br", 1.5)).toBe(272 * MiB);
	});

	test("rejects an unknown method", () =>
	{
		expect(() => decodeWeight("gzip", 10)).toThrow(TypeError);
	});
});

describe("parseDecodeBudgetMiB", () =>
{
	test("defaults to 768 and refuses anything below one maximum-size decode", () =>
	{
		expect(DEFAULT_DECODE_BUDGET_MIB).toBe(768);
		expect(MIN_DECODE_BUDGET_MIB).toBe(272);
		expect(parseDecodeBudgetMiB(undefined)).toBe(768);
		expect(parseDecodeBudgetMiB("")).toBe(768);
		expect(parseDecodeBudgetMiB("272")).toBe(272);
		expect(parseDecodeBudgetMiB("2048")).toBe(2048);
		expect(() => parseDecodeBudgetMiB("271")).toThrow(RangeError);
		expect(() => parseDecodeBudgetMiB("abc")).toThrow(RangeError);
		expect(() => parseDecodeBudgetMiB("500.5")).toThrow(RangeError);
		expect(() => parseDecodeBudgetMiB("-800")).toThrow(RangeError);
	});
});

describe("createWeightedSemaphore", () =>
{
	test("grants up to the capacity and queues the rest in arrival order", async () =>
	{
		const semaphore = createWeightedSemaphore(10);
		const releaseA = await semaphore.acquire(6);
		const granted = [];
		const waitB = semaphore.acquire(6).then((release) =>
		{
			granted.push("B");

			return release;
		});
		// Would fit now (4 left) but must not jump the queue.
		const waitC = semaphore.acquire(2).then((release) =>
		{
			granted.push("C");

			return release;
		});

		await settle();
		expect(granted).toEqual([]);
		expect(semaphore.available).toBe(4);
		expect(semaphore.waiting).toBe(2);

		releaseA();
		const releaseB = await waitB;
		const releaseC = await waitC;

		expect(granted).toEqual(["B", "C"]);
		expect(semaphore.available).toBe(2);

		releaseB();
		releaseC();
		expect(semaphore.available).toBe(10);
	});

	test("a release function frees its weight exactly once", async () =>
	{
		const semaphore = createWeightedSemaphore(10);
		const releaseA = await semaphore.acquire(6);
		const releaseB = await semaphore.acquire(3);

		expect(releaseA()).toBe(true);
		expect(releaseA()).toBe(false);
		expect(releaseA()).toBe(false);
		expect(semaphore.available).toBe(7);

		releaseB();
		expect(semaphore.available).toBe(10);
		releaseB();
		expect(semaphore.available).toBe(10);
	});

	test("clamps a weight above the capacity so it waits for an empty semaphore, not forever", async () =>
	{
		const semaphore = createWeightedSemaphore(10);
		const releaseA = await semaphore.acquire(1);
		const waitBig = semaphore.acquire(500);

		expect(await isPending(waitBig)).toBe(true);
		releaseA();

		const releaseBig = await waitBig;

		expect(semaphore.available).toBe(0);
		releaseBig();
		expect(semaphore.available).toBe(10);
	});

	test("an aborted waiter leaves the queue, holds nothing and unblocks the one behind it", async () =>
	{
		const semaphore = createWeightedSemaphore(10);
		const releaseA = await semaphore.acquire(8);
		const controller = new AbortController();
		const waitBig = semaphore.acquire(8, { signal: controller.signal });
		const waitSmall = semaphore.acquire(2);

		expect(await isPending(waitSmall)).toBe(true);
		controller.abort();
		await expect(waitBig).rejects.toBe(controller.signal.reason);
		expect(semaphore.waiting).toBe(0);

		(await waitSmall)();
		releaseA();
		expect(semaphore.available).toBe(10);
	});

	test("rejects at once for a signal that is already aborted", async () =>
	{
		const semaphore = createWeightedSemaphore(10);

		await expect(semaphore.acquire(1, { signal: AbortSignal.abort() })).rejects.toBeDefined();
		expect(semaphore.available).toBe(10);
	});

	test("times out with SemaphoreTimeoutError and holds nothing", async () =>
	{
		const semaphore = createWeightedSemaphore(10);
		const release = await semaphore.acquire(10);

		await expect(semaphore.acquire(1, { timeoutMs: 5 })).rejects.toBeInstanceOf(SemaphoreTimeoutError);
		expect(semaphore.waiting).toBe(0);
		release();
		expect(semaphore.available).toBe(10);
	});

	test("a waiter granted before its timeout is not rejected afterwards", async () =>
	{
		const semaphore = createWeightedSemaphore(10);
		const release = await semaphore.acquire(10);
		const wait = semaphore.acquire(5, { timeoutMs: 20 });

		release();

		const releaseWaiter = await wait;

		await new Promise((resolve) => setTimeout(resolve, 40));
		expect(semaphore.available).toBe(5);
		releaseWaiter();
	});

	test("validates its arguments", () =>
	{
		expect(() => createWeightedSemaphore(0)).toThrow(RangeError);
		expect(() => createWeightedSemaphore(Number.NaN)).toThrow(RangeError);
		expect(() => createWeightedSemaphore(4).acquire(0)).toThrow(RangeError);
		expect(() => createWeightedSemaphore(4).acquire(-1)).toThrow(RangeError);
	});
});

// ---- The download route ----

const sha = (data) => createHash("sha256").update(data).digest("hex");

let s3Bodies;

// Stored files for the next GetObject calls, consumed in order (the route reaches
// S3 in the order the requests were made).
let storedFiles;

harness.s3.send = async () =>
{
	const { method, originalSize, body, onReadName } = storedFiles.shift();
	const stream = body ?? new Readable({
		read()
		{}
	});
	const metadata = {
		...(method ? { compression: method } : {}),
		...(originalSize === undefined ? {} : { original_size: String(originalSize) }),
	};

	s3Bodies.push(stream);

	if (onReadName)
	{
		// The route reads the file name after it holds the permit and has set up the
		// streams, and before it checks for an abort: a hook to act at that moment.
		Object.defineProperty(metadata, "original_name", {
			enumerable: true,
			get()
			{
				onReadName();

				return undefined;
			},
		});
	}

	return {
		Body: stream,
		ContentLength: 10,
		ContentType: "application/octet-stream",
		Metadata: metadata,
	};
};

const fakeS3Send = harness.s3.send;

// Every response the route gave, so a test can never leave a body open that holds budget.
let responses;

// Starts a download. The promise resolves to the Response once the route has it.
function startDownload({ method = "zstd", originalSize, signal, body, onReadName } = {})
{
	harness.db.queue([{ file_id: FILE_ID }]);
	storedFiles.push({ method, originalSize, body, onReadName });

	return GET(new Request(`http://localhost/api/downloadFile?file_id=${FILE_ID}`, { signal })).then((response) =>
	{
		responses.push(response);

		return response;
	});
}

// Cancels every open response body and waits until each cancel has finished.
async function cancelAll()
{
	await Promise.all(responses.map((response) => response.body?.cancel().catch(() =>
	{})));
	await settle();
}

// Three zstd downloads whose weights add up to exactly the 768 MiB default budget.
const FULL_BUDGET_SIZES = [250 * MiB, 250 * MiB, 220 * MiB];

beforeEach(() =>
{
	harness.reset();
	harness.session.loggedIn = true;
	harness.session.userId = "user-1";
	s3Bodies = [];
	storedFiles = [];
	responses = [];
	harness.s3.send = fakeS3Send;
});

// The decode budget lives in the route module, so it outlives a test: whatever a
// test leaves held would starve the next one. After closing everything, the whole
// 768 MiB must be available again.
afterEach(async () =>
{
	jest.useRealTimers();
	harness.s3.send = fakeS3Send;
	await cancelAll();

	for (const body of s3Bodies)
	{
		body.destroy();
	}

	await settle();

	const full = await Promise.all(FULL_BUDGET_SIZES.map((originalSize) => startDownload({ originalSize })));

	expect(full.map((response) => response.status)).toEqual([200, 200, 200]);
	await cancelAll();
	harness.s3.send = originalSend;
});

afterAll(() =>
{
	uninstallRouteHarness();
});

describe("GET /api/downloadFile decode budget", () =>
{
	test("downloads and verifies a compressed file, then gives the budget back", async () =>
	{
		const data = Buffer.from("solid scan\n".repeat(500));
		const compressed = zlib.zstdCompressSync(data);

		// The route sees the checksum in the metadata of the stub.
		harness.db.queue([{ file_id: FILE_ID }]);
		harness.s3.send = async () => ({
			Body: Readable.from([compressed]),
			ContentLength: compressed.length,
			ContentType: "application/octet-stream",
			Metadata: { compression: "zstd", original_size: String(data.length), sha256: sha(data) },
		});

		const res = await GET(new Request(`http://localhost/api/downloadFile?file_id=${FILE_ID}`));

		expect(res.status).toBe(200);
		expect(res.headers.get("Content-Length")).toBe(String(data.length));
		expect(Buffer.from(await res.arrayBuffer()).equals(data)).toBe(true);

		await settle();

		// A leak of even this small download would stop the third one below.
		const responses = await Promise.all(FULL_BUDGET_SIZES.map((originalSize) => startDownload({ originalSize })));

		expect(responses.map((response) => response.status)).toEqual([200, 200, 200]);
		await Promise.all(responses.map((response) => response.body.cancel()));
	});

	test("holds a download back until budget is free, and a closed body frees it", async () =>
	{
		const [first, second, third] = await Promise.all(FULL_BUDGET_SIZES.map((originalSize) => startDownload({ originalSize })));

		expect([first.status, second.status, third.status]).toEqual([200, 200, 200]);

		const waiting = startDownload({ originalSize: 1024 });

		expect(await isPending(waiting)).toBe(true);

		await first.body.cancel();

		const granted = await waiting;

		expect(granted.status).toBe(200);
		await Promise.all([second, third, granted].map((response) => response.body.cancel()));
	});

	test("an abort of the request frees the budget", async () =>
	{
		const controller = new AbortController();
		const first = await startDownload({ originalSize: 250 * MiB, signal: controller.signal });
		const second = await startDownload({ originalSize: 250 * MiB });
		const third = await startDownload({ originalSize: 220 * MiB });
		const waiting = startDownload({ originalSize: 1024 });

		expect(await isPending(waiting)).toBe(true);

		controller.abort();

		const granted = await waiting;

		expect(granted.status).toBe(200);
		expect(first.status).toBe(200);
		await Promise.all([second, third, granted].map((response) => response.body.cancel()));
	});

	test("a failing S3 body frees the budget", async () =>
	{
		const failing = await startDownload({ originalSize: 250 * MiB });
		const second = await startDownload({ originalSize: 250 * MiB });
		const third = await startDownload({ originalSize: 220 * MiB });
		const waiting = startDownload({ originalSize: 1024 });

		expect(await isPending(waiting)).toBe(true);

		s3Bodies[0].destroy(new Error("connection reset"));
		await failing.body.cancel().catch(() =>
		{});

		const granted = await waiting;

		expect(granted.status).toBe(200);
		await Promise.all([second, third, granted].map((response) => response.body.cancel()));
	});

	test("releases once: closing, erroring and aborting the same download frees its weight a single time", async () =>
	{
		const controller = new AbortController();
		const first = await startDownload({ originalSize: 250 * MiB, signal: controller.signal });
		const second = await startDownload({ originalSize: 250 * MiB });
		const third = await startDownload({ originalSize: 220 * MiB });

		// Every release path for the first download, in a row.
		controller.abort();
		s3Bodies[0].destroy(new Error("late failure"));
		await first.body.cancel().catch(() =>
		{});
		await settle();
		controller.abort();

		// 266 MiB came back, so one more 266 MiB download fits and the next must wait.
		const fits = await startDownload({ originalSize: 250 * MiB });
		const waiting = startDownload({ originalSize: 250 * MiB });

		expect(fits.status).toBe(200);
		expect(await isPending(waiting)).toBe(true);

		await fits.body.cancel();
		await (await waiting).body.cancel();
		await Promise.all([second, third].map((response) => response.body.cancel()));
	});

	test("an abort that lands after the permit was granted frees it and answers 499", async () =>
	{
		const holders = await Promise.all(FULL_BUDGET_SIZES.slice(0, 2).map((originalSize) => startDownload({ originalSize })));
		const controller = new AbortController();
		const res = await startDownload({
			originalSize: 220 * MiB,
			signal: controller.signal,
			// Fires after acquire() resolved and the streams were built.
			onReadName: () => controller.abort(),
		});

		expect(res.status).toBe(499);
		await settle();

		// The two holders and this third one add up to the whole budget, so it only
		// gets in when the failed download gave its 236 MiB back.
		const third = await startDownload({ originalSize: 220 * MiB });

		expect(third.status).toBe(200);
		expect(holders.map((holder) => holder.status)).toEqual([200, 200]);
		await cancelAll();
	});

	test("a failure between the permit and the stream setup frees it and destroys the S3 body", async () =>
	{
		const holders = await Promise.all(FULL_BUDGET_SIZES.slice(0, 2).map((originalSize) => startDownload({ originalSize })));
		const realConsoleError = console.error;

		console.error = () =>
		{
		};

		let res;

		try
		{
			res = await startDownload({
				originalSize: 220 * MiB,
				onReadName: () =>
				{
					throw new Error("metadata exploded");
				},
			});
		}
		finally
		{
			console.error = realConsoleError;
		}

		expect(res.status).toBe(500);
		await settle();
		expect(s3Bodies.at(-1).destroyed).toBe(true);

		const third = await startDownload({ originalSize: 220 * MiB });

		expect(third.status).toBe(200);
		expect(holders.map((holder) => holder.status)).toEqual([200, 200]);
		await cancelAll();
	});

	test("a request that aborts while waiting gets 499, leaves the queue and destroys its S3 body", async () =>
	{
		const holders = await Promise.all(FULL_BUDGET_SIZES.map((originalSize) => startDownload({ originalSize })));
		const controller = new AbortController();
		const waiting = startDownload({ originalSize: 250 * MiB, signal: controller.signal });

		expect(await isPending(waiting)).toBe(true);
		controller.abort();

		const res = await waiting;

		expect(res.status).toBe(499);
		await settle();
		expect(s3Bodies.at(-1).destroyed).toBe(true);
		await Promise.all(holders.map((response) => response.body.cancel()));
	});

	test("answers 503 with Retry-After: 5 after waiting 20 s, and frees nothing it did not hold", async () =>
	{
		const holders = await Promise.all(FULL_BUDGET_SIZES.map((originalSize) => startDownload({ originalSize })));

		jest.useFakeTimers();

		const waiting = startDownload({ originalSize: 250 * MiB });

		// Microtasks only: the route has reached S3 and is now waiting for budget.
		while (s3Bodies.length < 4)
		{
			await Promise.resolve();
		}

		for (let tick = 0; tick < 20; tick++)
		{
			await Promise.resolve();
		}

		jest.advanceTimersByTime(19_999);
		expect(await Promise.race([waiting, Promise.resolve("pending")])).toBe("pending");
		jest.advanceTimersByTime(1);

		const res = await waiting;

		expect(res.status).toBe(503);
		expect(res.headers.get("Retry-After")).toBe("5");
		expect((await res.json()).success).toBe(false);
		expect(s3Bodies.at(-1).destroyed).toBe(true);

		jest.useRealTimers();

		// The three holders still hold their weight: a new download still waits.
		const stillWaiting = startDownload({ originalSize: 1024 });

		expect(await isPending(stillWaiting)).toBe(true);
		await holders[0].body.cancel();
		expect((await stillWaiting).status).toBe(200);
		await (await stillWaiting).body.cancel();
		await Promise.all(holders.slice(1).map((response) => response.body.cancel()));
	});

	test("uncompressed downloads are not held back by a full budget", async () =>
	{
		const holders = await Promise.all(FULL_BUDGET_SIZES.map((originalSize) => startDownload({ originalSize })));
		const plain = await startDownload({ method: null });

		expect(plain.status).toBe(200);

		const identity = await startDownload({ method: "identity" });

		expect(identity.status).toBe(200);
		await Promise.all([plain, identity, ...holders].map((response) => response.body.cancel()));
	});

	test("a brotli download without a valid original_size takes the maximum weight", async () =>
	{
		// 272 MiB + 272 MiB = 544; a third 272 MiB would make 816 > 768.
		const first = await startDownload({ method: "br" });
		const second = await startDownload({ method: "br", originalSize: "not-a-number" });
		const waiting = startDownload({ method: "br" });

		expect(await isPending(waiting)).toBe(true);
		await first.body.cancel();
		expect((await waiting).status).toBe(200);
		await (await waiting).body.cancel();
		await second.body.cancel();
	});
});
