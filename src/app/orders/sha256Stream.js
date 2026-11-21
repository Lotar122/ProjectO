import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";

/**
 * Lowercase hex SHA-256 of a byte stream. Each chunk is hashed as it arrives and
 * then dropped, so memory use stays at one chunk no matter how large the input is.
 * @param {ReadableStream<Uint8Array>} stream Not reused afterwards: it is read to the end or cancelled.
 * @returns {Promise<string>}
 */
export const sha256HexFromStream = async (stream) =>
{
	if (typeof stream?.getReader !== "function")
	{
		throw new TypeError("sha256HexFromStream expects a ReadableStream.");
	}

	const reader = stream.getReader();
	const hash = sha256.create();

	try
	{
		for (;;)
		{
			const { done, value } = await reader.read();

			if (done)
			{
				break;
			}

			hash.update(value);
		}
	}
	catch (err)
	{
		await reader.cancel(err).catch(() =>
		{
			// The stream already failed; its own error is the one to report.
		});
		throw err;
	}
	finally
	{
		reader.releaseLock();
	}

	return bytesToHex(hash.digest());
};

/**
 * Blobs up to this size are hashed with crypto.subtle (native, fast, but it needs the
 * whole blob in memory). Larger ones use the incremental pure-JS path so memory stays at
 * one chunk, at the cost of speed.
 */
export const SUBTLE_MAX_BYTES = 32 * 1024 * 1024;

const getSubtle = (cryptoApi) =>
{
	return typeof cryptoApi?.subtle?.digest === "function" ? cryptoApi.subtle : null;
};

/**
 * Lowercase hex SHA-256 of a Blob or File. Uses crypto.subtle for blobs up to
 * SUBTLE_MAX_BYTES when it exists (secure contexts only); otherwise, or if it fails,
 * reads the blob in chunks without a second in-memory copy. Both give the same digest.
 * @param {Blob} blob
 * @param {{ crypto?: Crypto, subtleMaxBytes?: number }} [options] Overrides for tests.
 * @returns {Promise<string>}
 */
export const sha256HexFromBlob = async (blob, options = {}) =>
{
	if (typeof blob?.stream !== "function")
	{
		throw new TypeError("sha256HexFromBlob expects a Blob.");
	}

	const { crypto: cryptoApi = globalThis.crypto, subtleMaxBytes = SUBTLE_MAX_BYTES } = options;
	const subtle = getSubtle(cryptoApi);

	if (subtle && blob.size <= subtleMaxBytes)
	{
		try
		{
			return bytesToHex(new Uint8Array(await subtle.digest("SHA-256", await blob.arrayBuffer())));
		}
		catch
		{
			// Fall through to the incremental path.
		}
	}

	return sha256HexFromStream(blob.stream());
};
