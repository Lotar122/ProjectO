// In-memory archive_pending_verify for the archiver tests. It answers the
// statements in src/app/server-functions/orders/archiveJournal.js (matched by
// their whitespace-normalized text, values by position) the way Postgres
// would: the primary key on file_id, the 'needs_attention' guard on UPDATE /
// DELETE, and bigint columns returned as strings like postgres.js. Also
// answers isFileOnAnyOrder, the needs_attention count of getArchiveStatus and
// listJournaledFileIds (the rename check in orderFiles.js).

const normalize = (strings) => strings.join("?").replace(/\s+/g, " ").trim();

// Statement kinds, in the order they are matched.
const STATEMENTS = [
	["insert", (text) => text.startsWith("INSERT INTO archive_pending_verify")],
	["uploaded", (text) => text.startsWith("UPDATE archive_pending_verify SET stored_etag")],
	["needsAttention", (text) => text.startsWith("UPDATE archive_pending_verify SET state = 'needs_attention'")],
	["delete", (text) => text.startsWith("DELETE FROM archive_pending_verify")],
	["list", (text) => text.startsWith("SELECT file_id, job_id") && text.includes("FROM archive_pending_verify")],
	["listPaths", (text) => text === "SELECT original_path FROM archive_pending_verify"],
	["count", (text) => text.startsWith("SELECT count(*)::int AS count FROM archive_pending_verify WHERE state = 'needs_attention'")],
	["onAnyOrder", (text) => text === "SELECT 1 FROM orders WHERE ? = ANY(files) LIMIT 1"],
	["journaled", (text) => text === "SELECT file_id FROM archive_pending_verify WHERE file_id = ANY(?::text[])"],
];

/**
 * @param {object} [options]
 * @param {object[] | (() => object[])} [options.orders] { order_id, files } rows for isFileOnAnyOrder.
 */
export function createFakeJournal({ orders = [] } = {})
{
	let sequence = 0;

	const journal = {
		rows: new Map(),
		// Every journal statement kind, in the order it ran.
		log: [],
		// Test knobs: fail the next n statements of a kind, or never settle them.
		failures: Object.fromEntries(STATEMENTS.map(([kind]) => [kind, 0])),
		hangs: new Set(),
		orders,

		/**
		 * Adds a row as archiveOrderFile would have written it.
		 * @param {object} row Columns; file_id, original_path and the checksum fields are required.
		 */
		seed(row)
		{
			journal.rows.set(row.file_id, {
				job_id: "41",
				method: "zstd",
				stored_etag: null,
				state: "uploading",
				note: null,
				...row,
				original_size: String(row.original_size),
				stored_size: String(row.stored_size),
				seq: sequence++,
			});
		},

		/**
		 * The answer to one statement, or undefined when it is not a journal statement.
		 * @param {string} text Normalized statement text.
		 * @param {unknown[]} values
		 */
		handle(text, values)
		{
			const kind = STATEMENTS.find(([, matches]) => matches(text))?.[0];

			if (!kind)
			{
				return undefined;
			}

			journal.log.push(kind);

			if (journal.hangs.has(kind))
			{
				return new Promise(() => undefined);
			}

			if (journal.failures[kind] > 0)
			{
				journal.failures[kind]--;
				throw new Error(`fake journal: ${kind} failed (connection reset)`);
			}

			return run(kind, values);
		},
	};

	function run(kind, values)
	{
		switch (kind)
		{
			case "insert":
			{
				const [fileId, jobId, method, originalSha256, originalSize, storedSize, preUploadEtag, originalPath] = values;

				if (journal.rows.has(fileId))
				{
					throw Object.assign(
						new Error("duplicate key value violates unique constraint \"archive_pending_verify_pkey\""),
						{ code: "23505" },
					);
				}

				for (const [name, value] of Object.entries({ jobId, method, originalSha256, preUploadEtag, originalPath }))
				{
					if (value === null || value === undefined)
					{
						throw new Error(`null value in column ${name} violates not-null constraint`);
					}
				}

				journal.seed({
					file_id: fileId,
					job_id: String(jobId),
					method,
					original_sha256: originalSha256,
					original_size: originalSize,
					stored_size: storedSize,
					pre_upload_etag: preUploadEtag,
					original_path: originalPath,
				});

				return [];
			}
			case "uploaded":
			{
				const [storedEtag, fileId] = values;
				const row = journal.rows.get(fileId);

				if (!row || row.state === "needs_attention")
				{
					return [];
				}

				Object.assign(row, { stored_etag: storedEtag, state: "uploaded" });

				return [{ file_id: fileId }];
			}
			case "needsAttention":
			{
				const [note, fileId] = values;
				const row = journal.rows.get(fileId);

				if (!row)
				{
					return [];
				}

				Object.assign(row, { state: "needs_attention", note });

				return [{ file_id: fileId }];
			}
			case "delete":
			{
				const [fileId, originalPath] = values;
				const row = journal.rows.get(fileId);

				// deletePendingVerifyAttempt: only that attempt's 'uploading' row.
				if (values.length > 1)
				{
					if (row?.original_path === originalPath && row.state === "uploading")
					{
						journal.rows.delete(fileId);
					}

					return [];
				}

				if (row?.state !== "needs_attention")
				{
					journal.rows.delete(fileId);
				}

				return [];
			}
			case "list":
				return [...journal.rows.values()]
					.filter((row) => row.state === "uploading" || row.state === "uploaded")
					.sort((a, b) => a.seq - b.seq)
					.map(({ seq, note, ...row }) => ({ ...row }));
			case "listPaths":
				return [...journal.rows.values()].map((row) => ({ original_path: row.original_path }));
			case "count":
				return [{ count: [...journal.rows.values()].filter((row) => row.state === "needs_attention").length }];
			case "onAnyOrder":
			{
				const [fileId] = values;
				const list = typeof journal.orders === "function" ? journal.orders() : journal.orders;

				return list.some((order) => order.files?.includes(fileId)) ? [{ "?column?": 1 }] : [];
			}
			case "journaled":
			{
				const [fileIds] = values;

				return fileIds.filter((fileId) => journal.rows.has(fileId)).map((fileId) => ({ file_id: fileId }));
			}
			default:
				throw new Error(`fake journal: unhandled ${kind}`);
		}
	}

	/**
	 * A postgres.js-shaped client for the journal alone. Statements about
	 * archive_jobs / archive_workers (getArchiveStatus) get no rows; anything
	 * else is a test bug.
	 */
	journal.sql = (strings, ...values) =>
	{
		const text = normalize(strings);

		try
		{
			const result = journal.handle(text, values);

			if (result !== undefined)
			{
				return Promise.resolve(result);
			}
		}
		catch (err)
		{
			return Promise.reject(err);
		}

		if (/FROM archive_(jobs|workers)\b/.test(text))
		{
			return Promise.resolve([]);
		}

		return Promise.reject(new Error(`fake journal: unexpected query ${text}`));
	};
	journal.sql.json = (value) => ({ json: value });

	return journal;
}
