import test from "node:test";
import assert from "node:assert/strict";
import { cleanUpOrderFiles } from "../src/app/server-functions/orders/orderFiles.js";

// S3 stand-in that answers each DeleteObjects call with the next scripted
// result: an array of keys that failed, or an Error to throw.
function scriptedS3(results)
{
	const deleteCalls = [];

	return {
		deleteCalls,
		async send(command)
		{
			assert.equal(command.constructor.name, "DeleteObjectsCommand");
			deleteCalls.push(command.input.Delete.Objects.map(({ Key }) => Key));

			const result = results.shift() ?? [];

			if (result instanceof Error)
			{
				throw result;
			}

			return { Errors: result.map((Key) => ({ Key, Code: "InternalError" })) };
		},
	};
}

function recordingLog()
{
	const errors = [];

	return {
		errors,
		error: (message, details) =>
		{
			errors.push({ message, details });
		},
	};
}

test("cleanUpOrderFiles deletes everything in one call when storage accepts it", async () =>
{
	const s3 = scriptedS3([[]]);
	const log = recordingLog();

	assert.deepEqual(await cleanUpOrderFiles(s3, ["a", "b"], { log, context: "a failed order" }), []);
	assert.deepEqual(s3.deleteCalls, [["a", "b"]]);
	assert.deepEqual(log.errors, []);
});

test("cleanUpOrderFiles retries only the failed ids and stays quiet when the retry works", async () =>
{
	const s3 = scriptedS3([["b"], []]);
	const log = recordingLog();

	assert.deepEqual(await cleanUpOrderFiles(s3, ["a", "b", "c"], { log, context: "a failed order" }), []);
	assert.deepEqual(s3.deleteCalls, [["a", "b", "c"], ["b"]]);
	assert.deepEqual(log.errors, []);
});

test("cleanUpOrderFiles logs the count and ids still left after the retry", async () =>
{
	const s3 = scriptedS3([["a", "c"], ["a", "c"]]);
	const log = recordingLog();

	assert.deepEqual(await cleanUpOrderFiles(s3, ["a", "b", "c"], { log, context: "a failed update" }), ["a", "c"]);
	assert.deepEqual(s3.deleteCalls, [["a", "b", "c"], ["a", "c"]]);
	assert.equal(log.errors.length, 1);
	assert.equal(log.errors[0].message, "2 file(s) of a failed update left in storage: a, c");
});

test("cleanUpOrderFiles does not throw when DeleteObjects rejects, and logs it", async () =>
{
	const outage = new Error("connect ECONNREFUSED");
	const s3 = scriptedS3([outage, outage]);
	const log = recordingLog();

	const left = await cleanUpOrderFiles(s3, ["a", "b"], { log, context: "a failed order" });

	assert.deepEqual(left, ["a", "b"]);
	assert.deepEqual(s3.deleteCalls, [["a", "b"], ["a", "b"]]);
	assert.equal(log.errors.filter(({ details }) => details === outage).length, 2);
	assert.ok(log.errors.some(({ message }) => message === "2 file(s) of a failed order left in storage: a, b"));
});

test("cleanUpOrderFiles recovers when only the first attempt rejects", async () =>
{
	const s3 = scriptedS3([new Error("timeout"), []]);
	const log = recordingLog();

	assert.deepEqual(await cleanUpOrderFiles(s3, ["a"], { log, context: "a failed order" }), []);
	assert.deepEqual(s3.deleteCalls, [["a"], ["a"]]);
	// The rejected attempt is logged; nothing is reported as left behind.
	assert.equal(log.errors.length, 1);
	assert.doesNotMatch(log.errors[0].message, /left in storage/);
});

test("cleanUpOrderFiles sends nothing for an empty list and rejects a non-array", async () =>
{
	const s3 = scriptedS3([]);
	const log = recordingLog();

	assert.deepEqual(await cleanUpOrderFiles(s3, [], { log, context: "a failed order" }), []);
	assert.deepEqual(s3.deleteCalls, []);
	await assert.rejects(cleanUpOrderFiles(s3, "a", { log, context: "a failed order" }), TypeError);
});
