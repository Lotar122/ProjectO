import "server-only";

import { createHash } from "node:crypto";
import { Transform } from "node:stream";

export const CHECKSUM_MISMATCH = "CHECKSUM_MISMATCH";

const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;

function describeMismatch({ expected, actual, expectedSize, actualSize, context })
{
	const parts = context ? [context] : [];

	if (expected !== undefined && actual !== undefined && expected !== actual)
	{
		parts.push(`expected sha256 ${expected}, got ${actual}`);
	}

	if (expectedSize !== undefined && expectedSize !== actualSize)
	{
		parts.push(`expected ${expectedSize} bytes, got ${actualSize ?? "a different size"}`);
	}

	return parts.length > 0 ? ` (${parts.join("; ")})` : "";
}

// files: the ids or names whose content did not match. details (optional)
// carries, for a single file, the expected and actual sha256 and sizes and a
// short context (which check failed) for the message.
export class ChecksumMismatchError extends Error
{
	/**
	 * @param {readonly string[]} files
	 * @param {{ expected?: string, actual?: string, expectedSize?: number, actualSize?: number, context?: string }} [details]
	 */
	constructor(files, details = {})
	{
		super(`Checksum mismatch for: ${files.join(", ")}${describeMismatch(details)}`);
		this.name = "ChecksumMismatchError";
		this.code = CHECKSUM_MISMATCH;
		this.files = files;
		this.expected = details.expected ?? null;
		this.actual = details.actual ?? null;
		this.expectedSize = details.expectedSize ?? null;
		this.actualSize = details.actualSize ?? null;
		this.context = details.context ?? null;
	}
}

/**
 * True for a lower-case hex sha256 digest, the form stored in S3 metadata.
 * @param {unknown} value
 * @returns {boolean}
 */
export function isSha256Hex(value)
{
	return typeof value === "string" && SHA256_HEX_PATTERN.test(value);
}

function validateExpected(expected)
{
	if (!isSha256Hex(expected?.sha256))
	{
		throw new TypeError("expected.sha256 must be a lower-case hex sha256 digest");
	}

	if (expected.size !== undefined && !(Number.isSafeInteger(expected.size) && expected.size >= 0))
	{
		throw new RangeError("expected.size must be a non-negative safe integer when given");
	}
}

function mismatchOf(subject, expected, actual, context)
{
	const sizeDiffers = expected.size !== undefined && expected.size !== actual.size;

	if (expected.sha256 === actual.sha256 && !sizeDiffers)
	{
		return null;
	}

	return new ChecksumMismatchError([subject], {
		context,
		expected: expected.sha256,
		actual: actual.sha256,
		...(expected.size === undefined ? {} : { expectedSize: expected.size, actualSize: actual.size }),
	});
}

/**
 * Throws ChecksumMismatchError when actual does not match expected. The size
 * is compared only when expected.size is given.
 * @param {string} subject the file id or name that was checked (ends up in err.files)
 * @param {{ sha256: string, size?: number }} expected
 * @param {{ sha256: string, size: number }} actual
 * @param {string} [context] which check this is, for the message
 */
export function assertChecksum(subject, expected, actual, context)
{
	validateExpected(expected);

	const err = mismatchOf(subject, expected, actual, context);

	if (err)
	{
		throw err;
	}
}

/**
 * A pass-through stream that hashes everything it forwards and fails with
 * ChecksumMismatchError when the content does not match expected. The last
 * chunk is held back until the check passes, so a consumer of a mismatching
 * stream never receives the complete content (a download ends short of its
 * Content-Length and the client sees a failed transfer). A stream longer than
 * expected.size fails as soon as it goes past it.
 * @param {string} subject what is being streamed, used in the error message
 * @param {{ sha256: string, size?: number }} expected
 * @returns {import("node:stream").Transform}
 */
export function createChecksumVerifyStream(subject, expected)
{
	validateExpected(expected);

	const hash = createHash("sha256");
	let size = 0;
	let held = null;

	return new Transform({
		transform(chunk, encoding, callback)
		{
			hash.update(chunk);
			size += chunk.length;

			if (expected.size !== undefined && size > expected.size)
			{
				// actualSize is how far it got, not the full length.
				callback(new ChecksumMismatchError([subject], {
					expected: expected.sha256,
					expectedSize: expected.size,
					actualSize: size,
				}));
				return;
			}

			if (held)
			{
				this.push(held);
			}

			held = chunk;
			callback();
		},
		flush(callback)
		{
			const err = mismatchOf(subject, expected, { sha256: hash.digest("hex"), size });

			if (err)
			{
				callback(err);
				return;
			}

			if (held)
			{
				this.push(held);
			}

			callback();
		},
	});
}
