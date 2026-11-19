import "server-only";

import { DB } from "@/app/lib/db";
import { cleanUpOrderFiles, renameRetainedFiles } from "@/app/server-functions/orders/orderFiles";
import { selectOrderForUpdate } from "@/app/server-functions/orders/orderRowLock";

// A file is removed when the client left it out of `existingFileIds` and knew
// about it. Without `knownFileIds` (older clients) every file left out is
// removed, as before. With it, files added by a concurrent edit the client
// never saw stay on the order instead of being deleted.
function splitFileIds(currentFileIds, existingFileIds, knownFileIds)
{
	const removedFileIds = currentFileIds.filter((fileId) =>
		!existingFileIds.includes(fileId) &&
		(knownFileIds === null || knownFileIds.includes(fileId)));
	const retainedFileIds = currentFileIds.filter((fileId) => !removedFileIds.includes(fileId));

	return { retainedFileIds, removedFileIds };
}

function parseKnownFileIds(value)
{
	try
	{
		const parsed = JSON.parse(value);

		return Array.isArray(parsed) && parsed.every((item) => typeof item === "string") ? parsed : null;
	}
	catch
	{
		return null;
	}
}

/**
 * Reads the optional `knownFileIds` form field: a JSON array with the file ids
 * the client saw on the order when the edit started.
 *
 * A field that is present but malformed is logged and read as an empty list,
 * so the edit removes no files: a broken client must not delete files by accident.
 *
 * @param {string | null} value Raw field value (null when the field is absent).
 * @param {object} options
 * @param {{ warn: (message: string) => void }} options.log Logger of the caller.
 * @param {string} options.orderID Order being edited, for the log line.
 * @returns {string[] | null} The ids, [] when malformed, or null when absent (then
 *   every file left out of `existingFileIds` counts as removed, as for older clients).
 */
export function readKnownFileIds(value, { log, orderID })
{
	if (typeof log?.warn !== "function")
	{
		throw new TypeError("readKnownFileIds: log must be a logger");
	}

	if (value === null || value === undefined)
	{
		return null;
	}

	const knownFileIds = typeof value === "string" ? parseKnownFileIds(value) : null;

	if (knownFileIds === null)
	{
		log.warn(`Order ${orderID}: malformed knownFileIds, no files are removed by this edit`);

		return [];
	}

	return knownFileIds;
}

function assertStringArray(value, name)
{
	if (!Array.isArray(value) || !value.every((item) => typeof item === "string"))
	{
		throw new TypeError(`applyOrderEdit: ${name} must be an array of strings`);
	}
}

/**
 * Applies an order edit atomically. The order row is locked (`SELECT ... FOR
 * UPDATE`) while the new file list is computed and written, so two edits of
 * the same order, or an edit racing a delete or a status change, cannot work
 * from a stale read.
 *
 * S3 work happens only after the commit: retained files are renamed (metadata
 * only) and removed files are deleted. Failures there are logged and do not
 * undo the saved edit, because the order then already points at the uploads.
 *
 * When the result is not "ok", nothing was written and the caller still owns
 * `uploadedFileIds` (it should delete them).
 *
 * @param {object} options
 * @param {object} options.s3 S3 client.
 * @param {string} options.orderID Order to edit.
 * @param {string | null} options.ownerId Owner the order must belong to; null for an admin edit.
 * @param {string} options.patient New patient name.
 * @param {string} options.details New details.
 * @param {string | null} options.dueDate New due date (YYYY-MM-DD) or null.
 * @param {readonly string[]} options.existingFileIds Files the client keeps.
 * @param {readonly string[] | null} [options.knownFileIds] Files the client saw on the order when the
 *   edit started; null when the client did not send them.
 * @param {readonly string[]} options.uploadedFileIds Files uploaded with this edit, appended in order.
 * @param {readonly string[]} options.fileNameUpdates JSON-encoded { fileId, fileName } rename requests.
 * @param {(row: { status: string | null }) => boolean} [options.assertEditable] Returns false when the
 *   locked order may not be edited; omitted for admins.
 * @param {{ error: (message: string, details?: unknown) => void }} options.log Logger of the caller.
 * @returns {Promise<
 *   { result: "ok", order: object, removedFileIds: string[], undeletedFileIds: string[] } |
 *   { result: "not_found" } |
 *   { result: "locked" }
 * >}
 */
export async function applyOrderEdit({
	s3,
	orderID,
	ownerId,
	patient,
	details,
	dueDate,
	existingFileIds,
	knownFileIds = null,
	uploadedFileIds,
	fileNameUpdates,
	assertEditable,
	log,
})
{
	if (!s3 || typeof s3.send !== "function")
	{
		throw new TypeError("applyOrderEdit: s3 must be an S3 client");
	}

	if (typeof orderID !== "string" || !orderID)
	{
		throw new TypeError("applyOrderEdit: orderID must be a non-empty string");
	}

	if (ownerId !== null && (typeof ownerId !== "string" || !ownerId))
	{
		throw new TypeError("applyOrderEdit: ownerId must be a non-empty string or null");
	}

	assertStringArray(existingFileIds, "existingFileIds");
	assertStringArray(uploadedFileIds, "uploadedFileIds");
	assertStringArray(fileNameUpdates, "fileNameUpdates");

	if (knownFileIds !== null)
	{
		assertStringArray(knownFileIds, "knownFileIds");
	}

	if (assertEditable !== undefined && typeof assertEditable !== "function")
	{
		throw new TypeError("applyOrderEdit: assertEditable must be a function");
	}

	if (typeof log?.error !== "function")
	{
		throw new TypeError("applyOrderEdit: log must be a logger");
	}

	const outcome = await DB.begin(async (sql) =>
	{
		const row = await selectOrderForUpdate(sql, orderID, ownerId);

		if (!row)
		{
			return { result: "not_found" };
		}

		if (assertEditable && !assertEditable(row))
		{
			return { result: "locked" };
		}

		const currentFileIds = Array.isArray(row.files) ? row.files : [];
		const { retainedFileIds, removedFileIds } = splitFileIds(currentFileIds, existingFileIds, knownFileIds);
		const nextFileIds = [...retainedFileIds, ...uploadedFileIds];

		// Files were added, so whatever the archiver did to this order no longer covers all of them.
		const [order] = await sql`
			UPDATE orders
			SET patient = ${patient},
				details = ${details},
				due_date = ${dueDate},
				files = ${nextFileIds}
				${uploadedFileIds.length > 0 ? sql`, archived_at = NULL` : sql``}
			WHERE order_id = ${orderID}
			RETURNING *
		`;

		return { result: "ok", order, retainedFileIds, removedFileIds };
	});

	if (outcome.result !== "ok")
	{
		return outcome;
	}

	const { order, retainedFileIds, removedFileIds } = outcome;

	try
	{
		await renameRetainedFiles(s3, patient, retainedFileIds, fileNameUpdates);
	}
	catch (err)
	{
		log.error(`Order ${orderID} saved, but renaming its files failed`, err);
	}

	const undeletedFileIds = await cleanUpOrderFiles(s3, removedFileIds, {
		log,
		context: `files removed from order ${orderID}`,
	});

	return { result: "ok", order, removedFileIds, undeletedFileIds };
}
