// Fast stand-in for nativeCompressBest in archiver tests: zstd level 3 through
// node:zlib, same contract ({ method, path, size, encoder } in a temp file the
// caller removes, or null for an empty file or too little saving).

import { readFile, writeFile } from "node:fs/promises";
import zlib from "node:zlib";
import { createTempFilePath } from "../../src/app/server-functions/orders/fileCompression.js";

export const TEST_ENCODER = "test-compressor/1 zstd-3";

/**
 * @param {string} srcPath
 * @param {{ minSavingsRatio?: number, signal?: AbortSignal, onProgress?: (progress: { phase: string, bytesDone: number, bytesTotal: number }) => void }} [options]
 * @returns {Promise<{ method: "zstd", path: string, size: number, encoder: string } | null>}
 */
export async function testCompressor(srcPath, { minSavingsRatio = 0.02, signal, onProgress } = {})
{
	signal?.throwIfAborted();

	const input = await readFile(srcPath);

	if (input.length === 0)
	{
		return null;
	}

	onProgress?.({ phase: "zstd", bytesDone: 0, bytesTotal: input.length });

	const output = zlib.zstdCompressSync(input, {
		params: {
			[zlib.constants.ZSTD_c_compressionLevel]: 3,
			[zlib.constants.ZSTD_c_checksumFlag]: 1,
		},
	});

	onProgress?.({ phase: "zstd", bytesDone: input.length, bytesTotal: input.length });

	if ((input.length - output.length) / input.length < minSavingsRatio)
	{
		return null;
	}

	const outputPath = createTempFilePath(".zst");

	await writeFile(outputPath, output);

	return { method: "zstd", path: outputPath, size: output.length, encoder: TEST_ENCODER };
}
