import "server-only";

export const CHECKSUM_MISMATCH = "CHECKSUM_MISMATCH";

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
