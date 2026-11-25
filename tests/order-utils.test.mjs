import { afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test";
import { createInitialOrder, dedupeNewFiles } from "../src/app/orders/orderUtils.js";

describe("createInitialOrder", () =>
{
	const originalTz = process.env.TZ;

	beforeEach(() =>
	{
		// Bun re-reads TZ on assignment, so the result does not depend on the machine.
		process.env.TZ = "Europe/Warsaw";
	});

	afterEach(() =>
	{
		setSystemTime();

		if (originalTz === undefined)
		{
			delete process.env.TZ;
		}
		else
		{
			process.env.TZ = originalTz;
		}
	});

	test("uses the local date when UTC is still the previous day", () =>
	{
		// 23:30 UTC on 31 Dec is 00:30 on 1 Jan in Warsaw (UTC+1).
		setSystemTime(new Date("2026-12-31T23:30:00Z"));

		expect(createInitialOrder()).toEqual({
			patient: "",
			details: "",
			orderingPartyId: "",
			dueDate: "2027-01-01",
		});
	});

	test("zero pads month and day", () =>
	{
		setSystemTime(new Date("2026-03-05T10:00:00Z"));

		expect(createInitialOrder().dueDate).toBe("2026-03-05");
	});

	test("is recomputed on every call", () =>
	{
		setSystemTime(new Date("2026-06-10T12:00:00Z"));
		expect(createInitialOrder().dueDate).toBe("2026-06-10");

		setSystemTime(new Date("2026-06-11T12:00:00Z"));
		expect(createInitialOrder().dueDate).toBe("2026-06-11");
	});

	test("returns a fresh object each time", () =>
	{
		expect(createInitialOrder()).not.toBe(createInitialOrder());
	});
});

describe("dedupeNewFiles", () =>
{
	const makeFile = (name, content, lastModified) =>
		new File([content], name, { lastModified });

	test("drops a file already in the list", () =>
	{
		const existing = [makeFile("a.stl", "abc", 1000)];
		const incoming = [makeFile("a.stl", "abc", 1000), makeFile("b.stl", "abc", 1000)];

		expect(dedupeNewFiles(existing, incoming).map((file) => file.name)).toEqual(["b.stl"]);
	});

	test("treats a different size or lastModified as a different file", () =>
	{
		const existing = [makeFile("a.stl", "abc", 1000)];
		const incoming = [makeFile("a.stl", "abcd", 1000), makeFile("a.stl", "abc", 2000)];

		expect(dedupeNewFiles(existing, incoming)).toHaveLength(2);
	});

	test("drops repeats inside the same selection", () =>
	{
		const incoming = [makeFile("a.stl", "abc", 1000), makeFile("a.stl", "abc", 1000)];

		expect(dedupeNewFiles([], incoming)).toHaveLength(1);
	});

	test("keeps incoming order and does not mutate its inputs", () =>
	{
		const existing = [makeFile("a.stl", "abc", 1000)];
		const incoming = [makeFile("c.stl", "x", 1), makeFile("a.stl", "abc", 1000), makeFile("b.stl", "y", 2)];
		const result = dedupeNewFiles(existing, incoming);

		expect(result.map((file) => file.name)).toEqual(["c.stl", "b.stl"]);
		expect(existing).toHaveLength(1);
		expect(incoming).toHaveLength(3);
	});

	test("rejects non-array input", () =>
	{
		expect(() => dedupeNewFiles(null, [])).toThrow(TypeError);
	});
});
