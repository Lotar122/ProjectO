import { describe, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { SUBTLE_MAX_BYTES, sha256HexFromBlob, sha256HexFromStream } from "../src/app/orders/sha256Stream.js";
import { computeSha256Hex, computeSha256HexSequentially } from "../src/app/orders/orderUtils.js";
import { discardFailedEdit, isFailedEditStale, rememberFailedEdit, takeFailedEdit } from "../src/app/orders/failedEdits.js";

const EMPTY = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const ABC = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
const ABC_448_BITS = "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1";

const streamOf = (chunks) => new ReadableStream({
	start(controller)
	{
		chunks.forEach((chunk) => controller.enqueue(chunk));
		controller.close();
	},
});

const nodeSha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

describe("sha256HexFromStream", () =>
{
	test("hashes an empty stream", async () =>
	{
		expect(await sha256HexFromStream(streamOf([]))).toBe(EMPTY);
	});

	test("matches the FIPS 180 test vectors", async () =>
	{
		const encoder = new TextEncoder();

		expect(await sha256HexFromStream(streamOf([encoder.encode("abc")]))).toBe(ABC);
		expect(
			await sha256HexFromStream(
				streamOf([encoder.encode("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq")]),
			),
		).toBe(ABC_448_BITS);
	});

	test("gives the same digest however the input is split", async () =>
	{
		const bytes = new Uint8Array(randomBytes(10_000));
		const expected = nodeSha256(bytes);
		const split = (sizes) =>
		{
			const chunks = [];
			let offset = 0;

			for (const size of sizes)
			{
				chunks.push(bytes.subarray(offset, offset + size));
				offset += size;
			}

			chunks.push(bytes.subarray(offset));
			return chunks;
		};

		expect(await sha256HexFromStream(streamOf([bytes]))).toBe(expected);
		expect(await sha256HexFromStream(streamOf(split([1, 63, 64, 65, 0, 4096])))).toBe(expected);
		expect(
			await sha256HexFromStream(streamOf(Array.from(bytes.subarray(0, 300), (byte) => Uint8Array.of(byte)))),
		).toBe(nodeSha256(bytes.subarray(0, 300)));
	});

	test("does not modify the chunks it is given", async () =>
	{
		const chunk = new Uint8Array(randomBytes(500));
		const before = chunk.slice();

		await sha256HexFromStream(streamOf([chunk]));

		expect(chunk).toEqual(before);
	});

	test("rejects with the stream error and unlocks it when the stream fails", async () =>
	{
		const failure = new Error("network down");
		const stream = new ReadableStream({
			pull()
			{
				throw failure;
			},
		});

		await expect(sha256HexFromStream(stream)).rejects.toBe(failure);
		expect(stream.locked).toBe(false);
	});

	test("rejects a value that is not a stream", async () =>
	{
		await expect(sha256HexFromStream(new Uint8Array(3))).rejects.toThrow(TypeError);
		await expect(sha256HexFromStream(null)).rejects.toThrow(TypeError);
	});
});

describe("sha256HexFromBlob", () =>
{
	test("hashes empty and non-empty blobs", async () =>
	{
		expect(await sha256HexFromBlob(new Blob([]))).toBe(EMPTY);
		expect(await sha256HexFromBlob(new Blob(["abc"]))).toBe(ABC);
	});

	test("hashes a multi-part blob larger than a chunk", async () =>
	{
		const parts = [randomBytes(70_000), randomBytes(1), randomBytes(200_000)];

		expect(await sha256HexFromBlob(new Blob(parts))).toBe(nodeSha256(Buffer.concat(parts)));
	});

	test("rejects with a TypeError for a non-blob", async () =>
	{
		await expect(sha256HexFromBlob("abc")).rejects.toThrow(TypeError);
	});

	test("uses crypto.subtle for blobs up to the threshold", async () =>
	{
		const bytes = randomBytes(5000);
		const calls = [];
		const cryptoApi = {
			subtle: {
				digest: async (algorithm, data) =>
				{
					calls.push(algorithm);
					return globalThis.crypto.subtle.digest(algorithm, data);
				},
			},
		};

		expect(SUBTLE_MAX_BYTES).toBe(32 * 1024 * 1024);
		expect(await sha256HexFromBlob(new Blob([bytes]), { crypto: cryptoApi })).toBe(nodeSha256(bytes));
		expect(calls).toEqual(["SHA-256"]);
	});

	test("uses the incremental path above the threshold and gives the same hex", async () =>
	{
		const bytes = randomBytes(5000);
		const cryptoApi = {
			subtle: {
				digest: async () =>
				{
					throw new Error("subtle must not be used");
				},
			},
		};
		const blob = new Blob([bytes]);

		expect(await sha256HexFromBlob(blob, { crypto: cryptoApi, subtleMaxBytes: 4999 })).toBe(nodeSha256(bytes));
	});

	test("uses the incremental path when crypto.subtle is missing", async () =>
	{
		const blob = new Blob(["abc"]);

		expect(await sha256HexFromBlob(blob, { crypto: {} })).toBe(ABC);
		expect(await sha256HexFromBlob(blob, { crypto: null })).toBe(ABC);
	});

	test("falls back to the incremental path when crypto.subtle fails", async () =>
	{
		const cryptoApi = {
			subtle: {
				digest: async () =>
				{
					throw new Error("not supported");
				},
			},
		};

		expect(await sha256HexFromBlob(new Blob(["abc"]), { crypto: cryptoApi })).toBe(ABC);
	});
});

describe("orderUtils checksum helpers", () =>
{
	test("computeSha256Hex hashes a blob", async () =>
	{
		expect(await computeSha256Hex(new Blob(["abc"]))).toBe(ABC);
	});

	test("computeSha256HexSequentially keeps order and null for missing files", async () =>
	{
		expect(await computeSha256HexSequentially([new Blob(["abc"]), null, new Blob([])])).toEqual([
			ABC,
			null,
			EMPTY,
		]);
	});
});

describe("failed edit store", () =>
{
	const edit = (name) => ({ order: { order_id: name }, draft: { patient: name }, files: [{ name }] });

	test("returns the saved edit once, then nothing", () =>
	{
		const store = new Map();
		const saved = edit("a");

		rememberFailedEdit(store, "a", saved);

		expect(takeFailedEdit(store, "a")).toBe(saved);
		expect(store.has("a")).toBe(false);
		expect(takeFailedEdit(store, "a")).toBeNull();
	});

	test("keeps edits of different orders apart and replaces a repeat failure", () =>
	{
		const store = new Map();
		const newer = edit("a2");

		rememberFailedEdit(store, "a", edit("a1"));
		rememberFailedEdit(store, "b", edit("b"));
		rememberFailedEdit(store, "a", newer);

		expect(takeFailedEdit(store, "a")).toBe(newer);
		expect(takeFailedEdit(store, "b").draft.patient).toBe("b");
		expect(store.size).toBe(0);
	});

	test("returns null for an order with no failed edit", () =>
	{
		expect(takeFailedEdit(new Map(), "missing")).toBeNull();
	});

	test("rejects a store that is not a Map", () =>
	{
		expect(() => takeFailedEdit({}, "a")).toThrow(TypeError);
		expect(() => rememberFailedEdit([], "a", edit("a"))).toThrow(TypeError);
	});
});

describe("failed edit staleness", () =>
{
	const order = (overrides = {}) => ({
		order_id: "o1",
		patient: "Jan",
		details: "crown",
		due_date: "2026-12-01",
		files: ["f1", "f2"],
		...overrides,
	});
	const edit = () => ({ order: order(), draft: { patient: "Jan" }, files: [{ name: "scan" }] });

	test("an unchanged order is not stale", () =>
	{
		expect(isFailedEditStale(edit(), order())).toBe(false);
		expect(isFailedEditStale(edit(), order({ files: ["f1", "f2"] }))).toBe(false);
	});

	test("added, removed or reordered files make it stale", () =>
	{
		expect(isFailedEditStale(edit(), order({ files: ["f1", "f2", "f3"] }))).toBe(true);
		expect(isFailedEditStale(edit(), order({ files: ["f1"] }))).toBe(true);
		expect(isFailedEditStale(edit(), order({ files: ["f2", "f1"] }))).toBe(true);
		expect(isFailedEditStale(edit(), order({ files: undefined }))).toBe(true);
	});

	test("a changed update time or edited field makes it stale", () =>
	{
		const withTime = { ...edit(), order: order({ updatedAt: "t1" }) };

		expect(isFailedEditStale(withTime, order({ updatedAt: "t1" }))).toBe(false);
		expect(isFailedEditStale(withTime, order({ updatedAt: "t2" }))).toBe(true);
		expect(isFailedEditStale(edit(), order({ patient: "Anna" }))).toBe(true);
		expect(isFailedEditStale(edit(), order({ details: "bridge" }))).toBe(true);
		expect(isFailedEditStale(edit(), order({ due_date: "2026-12-02" }))).toBe(true);
	});

	test("takeFailedEdit returns a fresh edit and drops a stale one", () =>
	{
		const store = new Map();
		const saved = edit();

		rememberFailedEdit(store, "o1", saved);
		expect(takeFailedEdit(store, "o1", order())).toBe(saved);

		rememberFailedEdit(store, "o1", saved);
		expect(takeFailedEdit(store, "o1", order({ files: ["f1", "f2", "f3"] }))).toBeNull();
		expect(store.has("o1")).toBe(false);
	});

	test("discardFailedEdit removes the edit and reports whether there was one", () =>
	{
		const store = new Map();

		rememberFailedEdit(store, "o1", edit());

		expect(discardFailedEdit(store, "o1")).toBe(true);
		expect(discardFailedEdit(store, "o1")).toBe(false);
		expect(takeFailedEdit(store, "o1")).toBeNull();
		expect(() => discardFailedEdit({}, "o1")).toThrow(TypeError);
	});

	test("isFailedEditStale rejects missing arguments", () =>
	{
		expect(() => isFailedEditStale(null, order())).toThrow(TypeError);
		expect(() => isFailedEditStale(edit(), null)).toThrow(TypeError);
	});
});
