// deleteOrderWithFiles against a real Postgres (gated on TEST_DB_URL): the
// deletion marker written in step 1 (microsecond precision) must still match in
// the guarded DELETE / UPDATE of step 3. A timestamptz parameter is serialized
// by postgres.js with millisecond precision, so the guard compares text.
//
// The real function runs on a postgres.js client whose search_path is a scratch
// schema (created and dropped here); S3 is a small stub. Run with
// `TEST_DB_URL=postgres://... bun test --conditions react-server tests/order-delete-marker-postgres.test.mjs`.

import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { readFile } from "node:fs/promises";

const TEST_DB_URL = process.env.TEST_DB_URL;

if (!TEST_DB_URL)
{
	console.log("order-delete-marker-postgres: TEST_DB_URL is not set; skipping the real-Postgres tests");
}

const DB_MODULE = Bun.fileURLToPath(new URL("../src/app/lib/db.js", import.meta.url));
const OWNER_ID = "11111111-1111-4111-8111-111111111111";
const FILE_A = "0190b2a4-0000-7000-8000-00000000000a";
const FILE_B = "0190b2a4-0000-7000-8000-00000000000b";
const ATTEMPTS = 20;

describe.skipIf(!TEST_DB_URL)("deleteOrderWithFiles on Postgres", () =>
{
	const schema = `order_delete_marker_test_${process.pid}`;
	let admin;
	let sql;
	let originalDbModule;
	let deleteOrderWithFiles;
	let orderCounter = 0;

	// Fails the keys in `failKeys`; `onSend` runs while S3 is "working", between steps 1 and 3.
	const createS3 = ({ failKeys = [], onSend } = {}) => ({
		send: async (command) =>
		{
			await onSend?.();

			const keys = command.input.Delete.Objects.map((object) => object.Key);

			return { Errors: keys.filter((key) => failKeys.includes(key)).map((Key) => ({ Key })) };
		},
	});

	const insertOrder = async (files) =>
	{
		const orderID = `order-${++orderCounter}`;

		await sql`INSERT INTO orders (order_id, user_id, status, files) VALUES (${orderID}, ${OWNER_ID}, 'pending', ${files})`;

		return orderID;
	};

	const readOrder = async (orderID) =>
	{
		const [row] = await sql`SELECT order_id, files, deleting_at::text AS marker, deleting_at = '2030-01-01 00:00:00.654321+00'::timestamptz AS taken_over FROM orders WHERE order_id = ${orderID}`;

		return row;
	};

	beforeAll(async () =>
	{
		const { default: postgres } = await import("postgres");
		const migration = await readFile(new URL("../db/migrations/2026-11-20_orders_deleting_at.sql", import.meta.url), "utf8");

		admin = postgres(TEST_DB_URL, { max: 1 });
		await admin.unsafe(`CREATE SCHEMA ${schema}`);
		sql = postgres(TEST_DB_URL, { max: 4, connection: { search_path: schema } });
		await sql.unsafe("CREATE TABLE orders (order_id text PRIMARY KEY, user_id text, status text, files text[])");
		await sql.unsafe(migration);

		originalDbModule = { ...(await import("../src/app/lib/db.js")) };
		mock.module(DB_MODULE, () => ({ ...originalDbModule, DB: sql }));
		({ deleteOrderWithFiles } = await import("../src/app/server-functions/orders/deleteOrderWithFiles.js"));
	});

	afterAll(async () =>
	{
		if (originalDbModule)
		{
			mock.module(DB_MODULE, () => originalDbModule);
		}

		await sql?.end({ timeout: 5 });
		await admin?.unsafe(`DROP SCHEMA ${schema} CASCADE`);
		await admin?.end({ timeout: 5 });
	});

	test("the guarded DELETE matches the marker with its microseconds (repeated, since the part is random)", async () =>
	{
		for (let attempt = 0; attempt < ATTEMPTS; attempt++)
		{
			const orderID = await insertOrder([FILE_A]);
			const outcome = await deleteOrderWithFiles({ s3: createS3(), orderID, ownerId: OWNER_ID });

			expect(outcome).toEqual({ result: "ok", fileCount: 1 });
			expect(await readOrder(orderID)).toBeUndefined();
		}
	});

	test("files_left: the guarded UPDATE keeps the failed files and clears the marker (repeated)", async () =>
	{
		for (let attempt = 0; attempt < ATTEMPTS; attempt++)
		{
			const orderID = await insertOrder([FILE_A, FILE_B]);
			const outcome = await deleteOrderWithFiles({ s3: createS3({ failKeys: [FILE_B] }), orderID, ownerId: OWNER_ID });

			expect(outcome).toEqual({ result: "files_left", undeletedFileIds: [FILE_B] });

			const row = await readOrder(orderID);

			expect(row.files).toEqual([FILE_B]);
			expect(row.marker).toBeNull();
		}
	});

	test("takeover: a changed marker makes both guarded statements write nothing", async () =>
	{
		for (const failKeys of [[], [FILE_B]])
		{
			const orderID = await insertOrder([FILE_A, FILE_B]);
			const takeover = async () =>
			{
				await sql`UPDATE orders SET deleting_at = '2030-01-01 00:00:00.654321+00' WHERE order_id = ${orderID}`;
			};
			const outcome = await deleteOrderWithFiles({ s3: createS3({ failKeys, onSend: takeover }), orderID, ownerId: OWNER_ID });

			expect(outcome).toEqual({ result: "deleting" });

			const row = await readOrder(orderID);

			expect(row.files).toEqual([FILE_A, FILE_B]);
			expect(row.taken_over).toBe(true);
		}
	});

	test("a row removed meanwhile by a takeover delete counts as deleted", async () =>
	{
		const orderID = await insertOrder([FILE_A]);
		const remove = async () =>
		{
			await sql`DELETE FROM orders WHERE order_id = ${orderID}`;
		};

		expect(await deleteOrderWithFiles({ s3: createS3({ onSend: remove }), orderID, ownerId: OWNER_ID }))
			.toEqual({ result: "ok", fileCount: 1 });
	});
});
