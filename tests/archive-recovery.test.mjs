// Crash journal and recovery (phases-bugfix/phase4.md 9.2 to 9.4, W23):
// recoverPendingVerifications against every row of the 9.3 table, the
// `finally` rule of archiveOrderFile, and the temp sweep. Runs against the
// HTTP S3 stand-in and an in-memory archive_pending_verify. A gated variant
// runs the journal SQL on a real Postgres when TEST_DB_URL is set.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { GetObjectCommand, HeadObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";

import { getArchiveStatus } from "../src/app/server-functions/orders/archiveJobs.js";
import * as journalSql from "../src/app/server-functions/orders/archiveJournal.js";
import {
	ArchiveFileError,
	FILE_OUTCOMES,
	archiveOrderFile,
	recoverPendingVerifications,
	sweepTempDir,
} from "../src/app/server-functions/orders/orderArchiver.js";
import { createFakeJournal } from "./helpers/fakeJournal.mjs";
import { withS3 } from "./helpers/s3Server.mjs";
import { testCompressor } from "./helpers/testCompressor.mjs";

const FILE_A = "01900000-0000-7000-8000-0000000000a1";
const FILE_B = "01900000-0000-7000-8000-0000000000b2";
const FILE_NAME = encodeURIComponent("Skan górny.stl");
const ARCHIVED_AT = "2026-11-19T10:00:00.000Z";
const ENCODER = "projecto-compress/1.0.0 zstd/1.5.7";

const sha = (data) => createHash("sha256").update(data).digest("hex");
const md5Etag = (body) => `"${createHash("md5").update(body).digest("hex")}"`;

function compressibleData(seed = 0)
{
	const lines = [];

	for (let i = 0; i < 2000; i++)
	{
		lines.push(`  facet normal ${(i % 7) / 7} ${seed} 1\n    vertex ${i} ${i * 5} ${i % 3}\n  endfacet\n`);
	}

	return Buffer.from(lines.join(""));
}

// ---- isolated temp and recovery directories ----

const TEMP_ENV_NAMES = ["TMPDIR", "TEMP", "TMP"];
let tempDir;
let recoveryDir;
let previousEnv;
let journal;

beforeEach(async () =>
{
	tempDir = await mkdtemp(path.join(os.tmpdir(), "projecto-recovery-tmp-"));
	recoveryDir = await mkdtemp(path.join(os.tmpdir(), "projecto-recovery-dir-"));
	previousEnv = [...TEMP_ENV_NAMES, "ARCHIVER_RECOVERY_DIR"].map((name) => [name, process.env[name]]);

	for (const name of TEMP_ENV_NAMES)
	{
		process.env[name] = tempDir;
	}

	process.env.ARCHIVER_RECOVERY_DIR = recoveryDir;
	journal = createFakeJournal();
});

afterEach(async () =>
{
	for (const [name, value] of previousEnv)
	{
		if (value === undefined)
		{
			delete process.env[name];
		}
		else
		{
			process.env[name] = value;
		}
	}

	await rm(tempDir, { recursive: true, force: true });
	await rm(recoveryDir, { recursive: true, force: true });
});

const tempFiles = async () => (await readdir(tempDir)).filter((name) => name.startsWith("projecto-archive-")).sort();
const exists = (filePath) => readFile(filePath).then(() => true, () => false);
const recover = (s3, options = {}) => recoverPendingVerifications(journal.sql, s3, { timeoutMs: 1000, ...options });

// ---- scenario: one file whose replacing upload has a journal row ----

// The original as it was before archiving, our archive of it, the kept
// original in the temp directory and its journal row. `stored` picks what S3
// holds now: "original", "archive", "corrupt-archive" (same length, one byte
// flipped), or "none".
async function scenario(objects, { fileId = FILE_A, stored = "archive", state = "uploaded", seed = 0 } = {})
{
	const data = compressibleData(seed);
	const archive = zlib.zstdCompressSync(data, { params: { [zlib.constants.ZSTD_c_checksumFlag]: 1 } });
	const originalPath = path.join(tempDir, `projecto-archive-${randomUUID()}`);
	const originalObject = {
		body: data,
		contentType: "model/stl",
		metadata: { original_name: FILE_NAME, sha256: sha(data) },
	};
	const archiveObject = (body) => ({
		body,
		contentType: "model/stl",
		metadata: {
			original_name: FILE_NAME,
			sha256: sha(data),
			compression: "zstd",
			original_size: String(data.length),
			archived_at: ARCHIVED_AT,
			encoder: ENCODER,
		},
	});

	await writeFile(originalPath, data);

	if (stored === "original")
	{
		objects.set(fileId, originalObject);
	}
	else if (stored === "archive")
	{
		objects.set(fileId, archiveObject(archive));
	}
	else if (stored === "corrupt-archive")
	{
		const corrupt = Buffer.from(archive);

		corrupt[Math.floor(corrupt.length / 2)] ^= 0xff;
		objects.set(fileId, archiveObject(corrupt));
	}

	journal.seed({
		file_id: fileId,
		state,
		method: "zstd",
		original_sha256: sha(data),
		original_size: data.length,
		stored_size: archive.length,
		pre_upload_etag: md5Etag(data),
		stored_etag: state === "uploading" ? null : md5Etag(archive),
		original_path: originalPath,
	});

	return { data, archive, originalPath };
}

const attach = (fileId) =>
{
	journal.orders = [{ order_id: 7, files: [fileId] }];
};

// Makes every request of CommandClass (for key, when given) fail with error.
function failCommand(s3, CommandClass, error, key)
{
	const send = s3.send.bind(s3);

	s3.send = (command, options) =>
	{
		if (command instanceof CommandClass && (key === undefined || command.input.Key === key))
		{
			return Promise.reject(error);
		}

		return send(command, options);
	};
}

const serviceUnavailable = () => Object.assign(new Error("ServiceUnavailable"), {
	name: "ServiceUnavailable",
	$metadata: { httpStatusCode: 503 },
});

const writes = (counters) => counters.put + counters.copy + counters.delete;

// ---- 9.3: one test per row of the table ----

describe("recoverPendingVerifications (9.3)", () =>
{
	test("404: the object was deleted; the row and the temp original go", async () =>
	{
		await withS3(async (s3, { counters }) =>
		{
			const { originalPath } = await scenario(new Map(), { stored: "none" });

			expect(await recover(s3)).toEqual({ checked: 1, cleared: 1, restored: 0, needsAttention: 0, kept: 0 });
			expect(journal.rows.size).toBe(0);
			expect(await exists(originalPath)).toBe(false);
			expect(writes(counters)).toBe(0);
		});
	});

	test("no compression marker: our upload never landed; our multipart upload for the key is aborted", async () =>
	{
		await withS3(async (s3, { objects, counters, requests, multipart }) =>
		{
			const { data, originalPath } = await scenario(objects, { stored: "original", state: "uploading" });

			// Parts sent by the crashed upload, plus another key's upload that
			// shares the prefix search and must survive.
			multipart.set("u-ours", { key: FILE_A, parts: new Map([[1, Buffer.from("part")]]) });
			multipart.set("u-other", { key: FILE_B, parts: new Map() });

			expect((await recover(s3)).cleared).toBe(1);

			const listing = requests.find((request) => request.method === "GET" && request.search.includes("uploads"));

			expect(new URLSearchParams(listing.search).get("prefix")).toBe(FILE_A);
			expect([...multipart.keys()]).toEqual(["u-other"]);
			expect(journal.rows.size).toBe(0);
			expect(await exists(originalPath)).toBe(false);
			expect(objects.get(FILE_A).body.equals(data)).toBe(true);
			expect(writes(counters)).toBe(0);
		});
	});

	test("ETag still equal to pre_upload_etag: our upload never landed, even with a marker", async () =>
	{
		await withS3(async (s3, { objects, counters }) =>
		{
			const { data, originalPath } = await scenario(objects, { stored: "original", state: "uploading" });

			// A metadata-only copy keeps the content ETag.
			objects.get(FILE_A).metadata.compression = "zstd";
			objects.get(FILE_A).etag = md5Etag(data);

			expect((await recover(s3)).cleared).toBe(1);
			expect(journal.rows.size).toBe(0);
			expect(await exists(originalPath)).toBe(false);
			expect(writes(counters)).toBe(0);
		});
	});

	test("our archive whose read-back passes: the row and the temp original go, the archive stays", async () =>
	{
		for (const state of ["uploading", "uploaded"])
		{
			journal = createFakeJournal();

			await withS3(async (s3, { objects, counters }) =>
			{
				const { archive, originalPath } = await scenario(objects, { state });

				expect(await recover(s3)).toEqual({ checked: 1, cleared: 1, restored: 0, needsAttention: 0, kept: 0 });
				expect(journal.rows.size).toBe(0);
				expect(await exists(originalPath)).toBe(false);
				expect(objects.get(FILE_A).body.equals(archive)).toBe(true);
				expect(writes(counters)).toBe(0);
			});
		}
	});

	test("our archive failing the read-back is replaced by the re-hashed original, If-Match on the current ETag", async () =>
	{
		await withS3(async (s3, { objects, requests }) =>
		{
			const { data, originalPath } = await scenario(objects, { stored: "corrupt-archive" });
			const currentEtag = md5Etag(objects.get(FILE_A).body);

			attach(FILE_A);

			expect(await recover(s3)).toEqual({ checked: 1, cleared: 0, restored: 1, needsAttention: 0, kept: 0 });

			const stored = objects.get(FILE_A);
			const restorePut = requests.find((request) => request.method === "PUT");

			expect(restorePut.headers["if-match"]).toBe(currentEtag);
			expect(stored.body.equals(data)).toBe(true);
			expect(stored.contentType).toBe("model/stl");
			// The original's metadata, without any archive key.
			expect(stored.metadata).toEqual({ original_name: FILE_NAME, sha256: sha(data) });
			expect(journal.rows.size).toBe(0);
			expect(await exists(originalPath)).toBe(false);
		});
	});

	test("our archive failing the read-back on no order: the object is deleted", async () =>
	{
		await withS3(async (s3, { objects, counters }) =>
		{
			const { originalPath } = await scenario(objects, { stored: "corrupt-archive" });

			expect((await recover(s3)).cleared).toBe(1);
			expect(objects.has(FILE_A)).toBe(false);
			expect(counters.put).toBe(0);
			expect(counters.delete).toBe(1);
			expect(journal.rows.size).toBe(0);
			expect(await exists(originalPath)).toBe(false);
		});
	});

	test("our archive failing the read-back with no kept original: needs_attention, nothing written", async () =>
	{
		await withS3(async (s3, { objects, counters }) =>
		{
			const { originalPath } = await scenario(objects, { stored: "corrupt-archive" });
			const archived = objects.get(FILE_A);

			attach(FILE_A);
			await rm(originalPath);

			expect((await recover(s3)).needsAttention).toBe(1);

			const row = journal.rows.get(FILE_A);

			expect(row.state).toBe("needs_attention");
			expect(row.note).toContain(originalPath);
			expect(row.note).toContain("ENOENT");
			expect(objects.get(FILE_A)).toBe(archived);
			expect(writes(counters)).toBe(0);
		});
	});

	test("a kept original that no longer matches original_sha256 is never restored", async () =>
	{
		await withS3(async (s3, { objects, counters }) =>
		{
			const { data, originalPath } = await scenario(objects, { stored: "corrupt-archive" });
			const tampered = Buffer.from(data);

			tampered[0] ^= 0xff;
			await writeFile(originalPath, tampered);
			attach(FILE_A);

			expect((await recover(s3)).needsAttention).toBe(1);

			const row = journal.rows.get(FILE_A);

			expect(row.state).toBe("needs_attention");
			expect(row.note).toContain("Checksum mismatch");
			expect(row.note).toContain("kept original re-hashed before restore");
			expect(writes(counters)).toBe(0);
			// Still referenced by the row, so it stays for the operator.
			expect(await exists(originalPath)).toBe(true);
		});
	});

	test("a kept original outside the temp directory is never read or removed", async () =>
	{
		await withS3(async (s3, { objects, counters }) =>
		{
			const { data } = await scenario(objects, { stored: "corrupt-archive" });
			const elsewhere = path.join(recoveryDir, "projecto-archive-elsewhere");

			await writeFile(elsewhere, data);
			journal.rows.get(FILE_A).original_path = elsewhere;
			attach(FILE_A);

			expect((await recover(s3)).needsAttention).toBe(1);
			expect(journal.rows.get(FILE_A).note).toContain("not an archiver temp file");
			expect(writes(counters)).toBe(0);
			expect(await exists(elsewhere)).toBe(true);
		});
	});

	test("a restore that fails saves the original to the recovery directory and sets needs_attention", async () =>
	{
		await withS3(async (s3, { objects }) =>
		{
			const { data, originalPath } = await scenario(objects, { stored: "corrupt-archive" });

			attach(FILE_A);

			expect((await recover(s3)).needsAttention).toBe(1);

			const savedTo = path.join(recoveryDir, `${FILE_A}.orig`);
			const info = JSON.parse(await readFile(path.join(recoveryDir, `${FILE_A}.json`), "utf8"));
			const row = journal.rows.get(FILE_A);

			expect((await readFile(savedTo)).equals(data)).toBe(true);
			expect(info.sha256).toBe(sha(data));
			expect(info.metadata).toEqual({ original_name: FILE_NAME, sha256: sha(data) });
			expect(row.state).toBe("needs_attention");
			expect(row.note).toContain(savedTo);
			expect(row.note).toContain("restore:");
			// The finally rule for recovery: the row still references it.
			expect(await exists(originalPath)).toBe(true);
		}, { beforePut: () => 500 });
	});

	test("a restore whose object was deleted meanwhile has nothing to restore; the row goes", async () =>
	{
		await withS3(async (s3, { objects }) =>
		{
			const { originalPath } = await scenario(objects, { stored: "corrupt-archive" });

			attach(FILE_A);

			expect((await recover(s3)).cleared).toBe(1);
			expect(objects.has(FILE_A)).toBe(false);
			expect(journal.rows.size).toBe(0);
			expect(await exists(originalPath)).toBe(false);
		}, {
			beforePut: ({ objects }) =>
			{
				objects.delete(FILE_A);
			},
		});
	});

	test("anything else (a newer write by someone else): logged, the row and the temp original go, the object stays", async () =>
	{
		const variants = [
			// Another archive: same method, different content.
			(object) => Object.assign(object.metadata, { sha256: "0".repeat(64) }),
			// Another method.
			(object) => Object.assign(object.metadata, { compression: "br" }),
			// Same metadata, different length.
			(object) =>
			{
				object.body = Buffer.concat([object.body, Buffer.from("x")]);
			},
		];

		for (const change of variants)
		{
			journal = createFakeJournal();

			await withS3(async (s3, { objects, counters }) =>
			{
				const { originalPath } = await scenario(objects);
				const object = objects.get(FILE_A);

				change(object);
				attach(FILE_A);

				expect((await recover(s3)).cleared).toBe(1);
				expect(objects.get(FILE_A)).toBe(object);
				expect(writes(counters)).toBe(0);
				expect(journal.rows.size).toBe(0);
				expect(await exists(originalPath)).toBe(false);
			});
		}
	});

	test("needs_attention rows are never processed", async () =>
	{
		await withS3(async (s3, { objects, requests }) =>
		{
			const { originalPath } = await scenario(objects, { stored: "corrupt-archive", state: "needs_attention" });
			const before = { ...journal.rows.get(FILE_A) };

			expect(await recover(s3)).toEqual({ checked: 0, cleared: 0, restored: 0, needsAttention: 0, kept: 0 });
			expect(await recover(s3)).toEqual({ checked: 0, cleared: 0, restored: 0, needsAttention: 0, kept: 0 });
			expect(requests).toHaveLength(0);
			expect(journal.rows.get(FILE_A)).toEqual(before);
			expect(await exists(originalPath)).toBe(true);
			expect((await getArchiveStatus({ sql: journal.sql })).needsAttention).toBe(1);
		});
	});

	test("a row that cannot be settled now is kept with its original; the other rows are still handled", async () =>
	{
		await withS3(async (s3, { objects }) =>
		{
			const first = await scenario(objects, { fileId: FILE_A, seed: 1 });
			const second = await scenario(new Map(), { fileId: FILE_B, stored: "none", seed: 2 });

			failCommand(s3, HeadObjectCommand, serviceUnavailable(), FILE_A);

			expect(await recover(s3)).toEqual({ checked: 2, cleared: 1, restored: 0, needsAttention: 0, kept: 1 });
			expect(journal.rows.get(FILE_A).state).toBe("uploaded");
			expect(await exists(first.originalPath)).toBe(true);
			expect(journal.rows.has(FILE_B)).toBe(false);
			expect(await exists(second.originalPath)).toBe(false);
		});
	});

	test("a read-back that cannot read the object restores the verified original (the safe outcome)", async () =>
	{
		await withS3(async (s3, { objects }) =>
		{
			const { data } = await scenario(objects);

			attach(FILE_A);
			failCommand(s3, GetObjectCommand, serviceUnavailable());

			// The verified original replaces our archive: the safe outcome.
			expect((await recover(s3)).restored).toBe(1);
			expect(objects.get(FILE_A).body.equals(data)).toBe(true);
			expect(journal.rows.size).toBe(0);
		});
	});

	test("a malformed row is flagged for attention and never acted on", async () =>
	{
		await withS3(async (s3, { objects, requests }) =>
		{
			await scenario(objects);
			journal.rows.get(FILE_A).original_sha256 = "not-a-digest";

			expect((await recover(s3)).needsAttention).toBe(1);
			expect(journal.rows.get(FILE_A).state).toBe("needs_attention");
			expect(requests).toHaveLength(0);
		});
	});

	test("journal statements are bounded, and a failing delete keeps the row and its original", async () =>
	{
		await withS3(async (s3, { objects }) =>
		{
			const { originalPath } = await scenario(objects);

			journal.hangs.add("list");
			await expect(recover(s3, { timeoutMs: 30 })).rejects.toThrow(/timed out after 30 ms/);

			journal.hangs.clear();
			journal.failures.delete = 1;
			expect((await recover(s3)).kept).toBe(1);
			expect(journal.rows.has(FILE_A)).toBe(true);
			expect(await exists(originalPath)).toBe(true);

			expect((await recover(s3)).cleared).toBe(1);
			expect(await exists(originalPath)).toBe(false);
		});
	});

	test("shouldStop ends recovery between rows", async () =>
	{
		await withS3(async (s3, { objects }) =>
		{
			await scenario(objects, { fileId: FILE_A, seed: 1 });
			await scenario(objects, { fileId: FILE_B, seed: 2 });

			let calls = 0;
			const summary = await recover(s3, { shouldStop: () => calls++ > 0 });

			expect(summary.checked).toBe(1);
			expect(journal.rows.size).toBe(1);
		});
	});

	test("refuses bad arguments", async () =>
	{
		await expect(recoverPendingVerifications(null, { send: () => undefined })).rejects.toThrow(TypeError);
		await expect(recoverPendingVerifications(journal.sql, {})).rejects.toThrow(TypeError);
		await expect(recoverPendingVerifications(journal.sql, { send: () => undefined }, { timeoutMs: 0 })).rejects.toThrow(RangeError);
		await expect(sweepTempDir({})).rejects.toThrow(TypeError);
	});
});

// ---- 9.2 / 9.5 end to end: archiveOrderFile, then recovery ----

describe("archiveOrderFile and recovery", () =>
{
	const options = (s3) => ({
		s3,
		fileId: FILE_A,
		compress: testCompressor,
		journal: { sql: journal.sql, jobId: "41", timeoutMs: 1000 },
	});

	function seedOriginal(objects, data)
	{
		objects.set(FILE_A, { body: data, contentType: "model/stl", metadata: { original_name: FILE_NAME, sha256: sha(data) } });
	}

	test("a successful file leaves no journal row and no temp file", async () =>
	{
		await withS3(async (s3, { objects }) =>
		{
			seedOriginal(objects, compressibleData());

			expect((await archiveOrderFile(options(s3))).outcome).toBe(FILE_OUTCOMES.compressed);
			expect(journal.rows.size).toBe(0);
			expect(await tempFiles()).toEqual([]);
		});
	});

	test("the finally rule: an upload with an unknown outcome keeps the original until recovery settles the row", async () =>
	{
		await withS3(async (s3, { objects, counters }) =>
		{
			const data = compressibleData();

			seedOriginal(objects, data);

			// The upload lands, but the response is lost (a crash or a reset).
			const send = s3.send.bind(s3);

			s3.send = async (command, sendOptions) =>
			{
				const result = await send(command, sendOptions);

				if (command instanceof PutObjectCommand)
				{
					throw Object.assign(new Error("socket hang up"), { name: "TimeoutError" });
				}

				return result;
			};

			await expect(archiveOrderFile(options(s3))).rejects.toThrow("socket hang up");

			const row = journal.rows.get(FILE_A);

			expect(row.state).toBe("uploading");
			expect(await tempFiles()).toEqual([path.basename(row.original_path)]);
			expect((await readFile(row.original_path)).equals(data)).toBe(true);
			expect(counters.put).toBe(1);

			// Next start: our archive is in place and reads back fine.
			s3.send = send;
			expect((await recover(s3)).cleared).toBe(1);
			expect(journal.rows.size).toBe(0);
			expect(await tempFiles()).toEqual([]);
			expect(objects.get(FILE_A).metadata.compression).toBe("zstd");
		});
	});

	test("an upload that failed before landing is undone by recovery: no marker, row and original removed", async () =>
	{
		await withS3(async (s3, { objects }) =>
		{
			const data = compressibleData();

			seedOriginal(objects, data);

			await expect(archiveOrderFile(options(s3))).rejects.toThrow();
			expect(journal.rows.get(FILE_A).state).toBe("uploading");
			expect(await tempFiles()).toHaveLength(1);

			expect((await recover(s3)).cleared).toBe(1);
			expect(journal.rows.size).toBe(0);
			expect(await tempFiles()).toEqual([]);
			expect(objects.get(FILE_A).body.equals(data)).toBe(true);
		}, { beforePut: ({ index }) => (index === 0 ? 500 : undefined) });
	});

	test("read-back and restore both failing: needs_attention, original kept, and it survives later recoveries and sweeps", async () =>
	{
		await withS3(async (s3, { objects }) =>
		{
			seedOriginal(objects, compressibleData());

			await expect(archiveOrderFile(options(s3))).rejects.toThrow(ArchiveFileError);

			const row = journal.rows.get(FILE_A);

			expect(row.state).toBe("needs_attention");
			expect(row.note).toContain(path.join(recoveryDir, `${FILE_A}.orig`));
			expect(await tempFiles()).toEqual([path.basename(row.original_path)]);

			// A restart: recovery and the sweep leave the row and its original.
			await recover(s3);
			await sweepTempDir({ sql: journal.sql, timeoutMs: 1000 });

			expect(journal.rows.get(FILE_A)).toEqual(row);
			expect(await tempFiles()).toEqual([path.basename(row.original_path)]);
			expect((await getArchiveStatus({ sql: journal.sql })).needsAttention).toBe(1);
		}, {
			corruptPuts: 1,
			beforePut: ({ index }) => (index === 1 ? 500 : undefined),
		});
	});
});

// ---- 9.4: temp sweep ----

describe("sweepTempDir (9.4)", () =>
{
	test("removes every candidate and unreferenced original, keeps referenced originals and everything else", async () =>
	{
		const referencedUploading = path.join(tempDir, "projecto-archive-referenced-1");
		const referencedAttention = path.join(tempDir, "projecto-archive-referenced-2");
		const names = {
			candidates: ["projecto-archive-a.zst", "projecto-archive-b.br"],
			// Anything else with the prefix is a downloaded original.
			unreferenced: ["projecto-archive-c", "projecto-archive-d", "projecto-archive-e.txt.gz"],
			unrelated: ["other.txt", "projecto-archiver-test-x"],
		};

		for (const name of [...names.candidates, ...names.unreferenced, ...names.unrelated])
		{
			await writeFile(path.join(tempDir, name), name);
		}

		await writeFile(referencedUploading, "kept 1");
		await writeFile(referencedAttention, "kept 2");
		await mkdir(path.join(tempDir, "projecto-archive-dir"));
		await symlink(referencedUploading, path.join(tempDir, "projecto-archive-link"));

		for (const [fileId, state, originalPath] of [[FILE_A, "uploading", referencedUploading], [FILE_B, "needs_attention", referencedAttention]])
		{
			journal.seed({
				file_id: fileId,
				state,
				original_sha256: "0".repeat(64),
				original_size: 1,
				stored_size: 1,
				pre_upload_etag: "\"e\"",
				original_path: originalPath,
			});
		}

		const counts = await sweepTempDir({ sql: journal.sql, timeoutMs: 1000 });

		expect(counts).toEqual({ candidatesRemoved: 2, originalsRemoved: 3, originalsKept: 2, failed: 0 });
		// Directories and symlinks are never touched.
		expect((await readdir(tempDir)).sort()).toEqual([
			"other.txt",
			"projecto-archive-dir",
			"projecto-archive-link",
			"projecto-archive-referenced-1",
			"projecto-archive-referenced-2",
			"projecto-archiver-test-x",
		]);
	});

	test("removes nothing when the journal cannot be read", async () =>
	{
		await writeFile(path.join(tempDir, "projecto-archive-c"), "original");
		await writeFile(path.join(tempDir, "projecto-archive-c.zst"), "candidate");
		journal.failures.listPaths = 1;

		await expect(sweepTempDir({ sql: journal.sql, timeoutMs: 1000 })).rejects.toThrow(/listPaths failed/);
		expect(await tempFiles()).toEqual(["projecto-archive-c", "projecto-archive-c.zst"]);
	});

	test("logs counts only", async () =>
	{
		await writeFile(path.join(tempDir, `projecto-archive-${FILE_A}`), "original");

		const lines = [];
		const original = console.log;

		console.log = (line) => lines.push(String(line));

		try
		{
			await sweepTempDir({ sql: journal.sql, timeoutMs: 1000 });
		}
		finally
		{
			console.log = original;
		}

		const sweepLines = lines.filter((line) => line.includes("Temp sweep"));

		expect(sweepLines).toHaveLength(1);
		expect(sweepLines[0]).not.toContain(FILE_A);
		expect(sweepLines[0]).not.toContain(tempDir);
	});
});

// ---- the journal SQL on a real Postgres (gated) ----

const TEST_DB_URL = process.env.TEST_DB_URL;

if (!TEST_DB_URL)
{
	console.log("archive-recovery: TEST_DB_URL is not set; skipping the real-Postgres journal tests");
}

describe.skipIf(!TEST_DB_URL)("crash journal on Postgres", () =>
{
	const schema = `archive_recovery_test_${process.pid}`;
	let admin;
	let sql;
	let jobId;

	const entry = (overrides = {}) => ({
		fileId: randomUUID(),
		jobId,
		method: "zstd",
		originalSha256: "a".repeat(64),
		originalSize: 5_000_000_000,
		storedSize: 1234,
		preUploadEtag: "\"etag\"",
		originalPath: "/work/tmp/projecto-archive-x",
		...overrides,
	});

	test("setup: apply the migration into a scratch schema", async () =>
	{
		const { default: postgres } = await import("postgres");
		const migration = await readFile(new URL("../db/migrations/2026-11-19_archive_jobs.sql", import.meta.url), "utf8");

		admin = postgres(TEST_DB_URL, { max: 1 });
		await admin.unsafe(`CREATE SCHEMA ${schema}`);
		sql = postgres(TEST_DB_URL, { max: 2, connection: { search_path: schema } });
		await sql.unsafe(migration);
		await sql.unsafe("CREATE TABLE orders (order_id text PRIMARY KEY, files text[], archived_at timestamptz)");
		[{ id: jobId }] = await sql`INSERT INTO archive_jobs (state) VALUES ('running') RETURNING id`;
	});

	test("insert, duplicate, uploaded, needs_attention guard, list, paths, delete and count", async () =>
	{
		const first = entry();
		const second = entry({ method: "br" });

		await journalSql.insertPendingVerify(sql, first);
		await journalSql.insertPendingVerify(sql, second);
		await expect(journalSql.insertPendingVerify(sql, first)).rejects.toMatchObject({ code: "23505" });

		expect(await journalSql.markPendingUploaded(sql, first.fileId, "\"stored\"")).toHaveLength(1);

		const rows = await journalSql.listPendingVerifications(sql);
		const listed = rows.find((row) => row.file_id === first.fileId);

		expect(rows).toHaveLength(2);
		expect(listed).toMatchObject({
			state: "uploaded",
			stored_etag: "\"stored\"",
			original_sha256: first.originalSha256,
			original_size: "5000000000",
			stored_size: "1234",
		});

		await journalSql.markPendingNeedsAttention(sql, second.fileId, "saved to /work/recovery/x.orig");
		// Neither the update nor the delete touches a needs_attention row.
		expect(await journalSql.markPendingUploaded(sql, second.fileId, "\"x\"")).toHaveLength(0);
		await journalSql.deletePendingVerify(sql, second.fileId);
		expect((await journalSql.listPendingVerifications(sql)).map((row) => row.file_id)).toEqual([first.fileId]);
		expect((await journalSql.listJournalOriginalPaths(sql))).toHaveLength(2);
		expect((await getArchiveStatus({ sql })).needsAttention).toBe(1);

		await journalSql.deletePendingVerify(sql, first.fileId);
		expect(await journalSql.listPendingVerifications(sql)).toEqual([]);
	});

	test("isFileOnAnyOrder and the markOrderArchived guard", async () =>
	{
		const { markOrderArchived } = await import("../src/app/server-functions/orders/orderArchiver.js");
		const pending = entry();

		await sql`INSERT INTO orders (order_id, files) VALUES ('o1', ${[pending.fileId]})`;
		expect(await journalSql.isFileOnAnyOrder(sql, pending.fileId)).toBe(true);
		expect(await journalSql.isFileOnAnyOrder(sql, randomUUID())).toBe(false);

		await journalSql.insertPendingVerify(sql, pending);
		expect(await markOrderArchived(sql, "o1", [pending.fileId])).toBe(false);

		await journalSql.deletePendingVerify(sql, pending.fileId);
		expect(await markOrderArchived(sql, "o1", [pending.fileId])).toBe(true);
	});

	test("teardown", async () =>
	{
		await sql?.end({ timeout: 5 });
		await admin?.unsafe(`DROP SCHEMA ${schema} CASCADE`);
		await admin?.end({ timeout: 5 });
	});
});
