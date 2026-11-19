import "server-only";

import { createWeightedSemaphore } from "@/app/lib/concurrency";
import {
	BROTLI_MAX_WINDOW_LOG,
	COMPRESSION_METHODS,
	ZSTD_MAX_WINDOW_LOG,
	windowLogFor,
} from "@/app/server-functions/orders/fileCompression";

const MIB = 1024 * 1024;

// Allowance for stream buffers and hash state, added on top of the decoder
// window that decodeWeight counts separately. Fixed by the plan (A6) at 16 MiB;
// a measured 200 MiB decode raised the process by 234 MiB in total.
const OVERHEAD_BYTES = 16 * MIB;

// Weight of a download whose original size is missing or invalid: the largest.
const MAX_WEIGHT_BYTES = 2 ** ZSTD_MAX_WINDOW_LOG + OVERHEAD_BYTES;

export const DEFAULT_DECODE_BUDGET_MIB = 768;

// One maximum-size decode. A smaller budget could never serve it.
export const MIN_DECODE_BUDGET_MIB = MAX_WEIGHT_BYTES / MIB;

// How long a download waits for budget before it is answered with 503.
export const DECODE_WAIT_MS = 20_000;

/**
 * Memory a streaming decode of one stored file may need, in bytes. zstd
 * allocates at most the content (capped by the window limit); brotli has no
 * content size, so the decoder may allocate its whole window.
 *
 * @param {string} method "zstd" or "br".
 * @param {number | undefined} originalSize Size of the original bytes, undefined when unknown.
 * @returns {number}
 */
export function decodeWeight(method, originalSize)
{
	if (method !== COMPRESSION_METHODS.zstd && method !== COMPRESSION_METHODS.brotli)
	{
		throw new TypeError(`Unsupported compression method: ${method}`);
	}

	if (!Number.isSafeInteger(originalSize) || originalSize < 0)
	{
		return MAX_WEIGHT_BYTES;
	}

	if (method === COMPRESSION_METHODS.zstd)
	{
		return Math.min(originalSize, 2 ** ZSTD_MAX_WINDOW_LOG) + OVERHEAD_BYTES;
	}

	return 2 ** windowLogFor(originalSize, BROTLI_MAX_WINDOW_LOG) + OVERHEAD_BYTES;
}

/**
 * Reads DOWNLOAD_DECODE_BUDGET_MIB.
 *
 * @param {string | undefined} value Raw environment value; undefined or empty gives the default.
 * @returns {number} Budget in MiB.
 * @throws {RangeError} For anything but an integer of at least MIN_DECODE_BUDGET_MIB.
 */
export function parseDecodeBudgetMiB(value)
{
	if (value === undefined || value === "")
	{
		return DEFAULT_DECODE_BUDGET_MIB;
	}

	const mib = /^\d+$/.test(value) ? Number(value) : Number.NaN;

	if (!Number.isSafeInteger(mib) || mib < MIN_DECODE_BUDGET_MIB)
	{
		throw new RangeError(
			`DOWNLOAD_DECODE_BUDGET_MIB must be an integer of at least ${MIN_DECODE_BUDGET_MIB}, got "${value}"`,
		);
	}

	return mib;
}

/**
 * Creates the semaphore that bounds the memory of concurrent decodes.
 *
 * @param {number} budgetMiB
 */
export function createDecodeBudget(budgetMiB)
{
	return createWeightedSemaphore(budgetMiB * MIB);
}
