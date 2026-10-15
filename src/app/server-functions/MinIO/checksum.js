import "server-only";

import { createHash } from "node:crypto";

export const CHECKSUM_MISMATCH = "CHECKSUM_MISMATCH";

export function sha256Hex(buffer)
{
	return createHash("sha256").update(buffer).digest("hex");
}

// S3 native checksums (ChecksumSHA256) are base64 encoded
export function hexToBase64(hex)
{
	return Buffer.from(hex, "hex").toString("base64");
}

export class ChecksumMismatchError extends Error
{
	constructor(files)
	{
		super(`Checksum mismatch for: ${files.join(", ")}`);
		this.name = "ChecksumMismatchError";
		this.code = CHECKSUM_MISMATCH;
		this.files = files;
	}
}
