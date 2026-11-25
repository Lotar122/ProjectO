import "server-only";

import { rm } from "node:fs/promises";

import { DB } from "@/app/lib/db";
import { describeDbError } from "@/app/lib/dbError";
import { createLogger } from "@/app/lib/logger";
import { deleteOrderWithFiles } from "@/app/server-functions/orders/deleteOrderWithFiles";
import { isTempOriginal, recoveryPaths } from "@/app/server-functions/orders/archiverRecovery";

const log = createLogger("admin");

/**
 * Counts what deleting an account's data would remove.
 *
 * @param {string} userId Kratos identity id, already validated.
 * @returns {Promise<{ orders: number, files: number, parties: number }>}
 */
export async function previewAccountData(userId)
{
	const [orderRow] = await DB`
		SELECT count(*)::int AS orders, COALESCE(sum(cardinality(files)), 0)::int AS files
		FROM orders
		WHERE user_id = ${userId}
	`;
	const [partyRow] = await DB`
		SELECT count(*)::int AS parties
		FROM ordering_parties
		WHERE user_id = ${userId}
	`;

	return {
		orders: orderRow?.orders ?? 0,
		files: orderRow?.files ?? 0,
		parties: partyRow?.parties ?? 0,
	};
}

// Removes what the archiver keeps for files that are gone from storage: the
// recovery copy and its metadata, and the crash journal row with its temp
// original. Returns the ids it could not clean up, which the caller treats as
// not deleted (a non-string element fails recoveryPaths and lands there too). Never throws; ids are random uuids, so logging them is safe.
//
// An account deletion is the one case where a 'needs_attention' journal row is
// removed: the file it points at no longer exists and its data must go. A row
// whose archive job is still queued or running is left alone and reported,
// because that job may be replacing the file right now.
async function cleanupFiles(fileIds)
{
	const failed = new Set();

	for (const fileId of fileIds)
	{
		try
		{
			const { filePath, infoPath } = recoveryPaths(fileId);

			await rm(filePath, { force: true });
			await rm(infoPath, { force: true });
		}
		catch (err)
		{
			log.warn(`Could not remove a recovery file of ${fileId}: ${err?.code ?? "unknown error"}`);
			failed.add(fileId);
		}
	}

	const candidates = fileIds.filter((fileId) => typeof fileId === "string" && !failed.has(fileId));

	if (candidates.length === 0)
	{
		return [...failed];
	}

	let journalRows;

	try
	{
		journalRows = await DB`
			SELECT p.file_id, p.original_path, p.state,
				EXISTS (
					SELECT 1 FROM archive_jobs j
					WHERE j.id = p.job_id AND j.state IN ('queued', 'running')
				) AS job_active
			FROM archive_pending_verify p
			WHERE p.file_id = ANY(${candidates}::text[])
		`;
	}
	catch (err)
	{
		log.error(`Could not read the archive journal: ${describeDbError(err)}`);

		return fileIds;
	}

	for (const row of journalRows)
	{
		if (!(await removeJournalRow(row)))
		{
			failed.add(row.file_id);
			log.warn(`Journal row of file ${row.file_id} could not be removed`);
		}
	}

	return [...failed];
}

// Removes one journal row and its temp original. False when it must stay (its
// job is active) or something failed, so the caller reports leftovers.
async function removeJournalRow(row)
{
	if (row.state !== "needs_attention" && row.job_active)
	{
		return false;
	}

	try
	{
		if (isTempOriginal(row.original_path))
		{
			await rm(row.original_path, { force: true });
		}

		await DB`
			DELETE FROM archive_pending_verify p
			WHERE p.file_id = ${row.file_id}
				AND (
					p.state = 'needs_attention'
					OR NOT EXISTS (
						SELECT 1 FROM archive_jobs j
						WHERE j.id = p.job_id AND j.state IN ('queued', 'running')
					)
				)
		`;

		// The delete is conditional (a job may have started meanwhile): the row must be gone.
		const left = await DB`SELECT 1 FROM archive_pending_verify WHERE file_id = ${row.file_id}`;

		return left.length === 0;
	}
	catch (err)
	{
		log.warn(`Journal cleanup of file ${row.file_id} failed: ${err?.code ?? describeDbError(err)}`);

		return false;
	}
}

// Deletes one order with its files and returns how many files went. `remaining`
// is true when the order is still there (locked, being archived or deleted by
// someone else, or its files or their archiver leftovers could not all be
// removed); `gone` is true when this call deleted it; `leftovers` counts archiver
// leftovers of an order that someone else already deleted.
async function deleteOneOrder({ s3, orderID, userId, fileIds })
{
	let outcome;

	try
	{
		outcome = await deleteOrderWithFiles({ s3, orderID, ownerId: userId, cleanupDeletedFiles: cleanupFiles });
	}
	catch (err)
	{
		log.error(`Order ${orderID}: deletion failed: ${describeDbError(err)}`);

		return { deletedFiles: 0, remaining: true, leftovers: 0 };
	}

	switch (outcome.result)
	{
		case "ok":
			return { deletedFiles: outcome.fileCount, remaining: false, gone: true, leftovers: 0 };

		case "not_found":
		{
			// Deleted by someone else since the list was read. Its archiver leftovers are still ours to clear.
			const failed = await cleanupFiles(fileIds);

			return { deletedFiles: 0, remaining: false, gone: false, leftovers: failed.length };
		}

		case "files_left":
			return { deletedFiles: Math.max(0, fileIds.length - outcome.undeletedFileIds.length), remaining: true, leftovers: 0 };

		default:
			return { deletedFiles: 0, remaining: true, leftovers: 0 };
	}
}

/**
 * Number of orders the account still has.
 *
 * @param {string} userId Kratos identity id, already validated.
 * @returns {Promise<number>}
 */
export async function countAccountOrders(userId)
{
	const [row] = await DB`
		SELECT count(*)::int AS remaining
		FROM orders
		WHERE user_id = ${userId}
	`;

	return row?.remaining ?? 0;
}

/**
 * Deletes everything stored for one account: orders with their files (through
 * deleteOrderWithFiles, so the deletion marker and the archiver are respected),
 * the archiver's recovery copies of those files, then the ordering parties and
 * the users row. The Kratos identity is not touched here, the caller removes it
 * only when `complete` is true.
 *
 * Safe to run again: it works from what is in the database now, and the counts
 * describe this run only. When any order stays or any archiver leftover could
 * not be removed, the parties and the user row are left alone and `complete`
 * is false.
 *
 * @param {object} options
 * @param {object} options.s3 S3 client.
 * @param {string} options.userId Kratos identity id, already validated.
 * @returns {Promise<{ complete: boolean, ordersDeleted: number, filesDeleted: number, ordersRemaining: number, leftovers: number, partiesDeleted: number }>}
 */
export async function deleteAccountData({ s3, userId })
{
	if (typeof userId !== "string" || !userId)
	{
		throw new TypeError("deleteAccountData: userId must be a non-empty string");
	}

	const orders = await DB`
		SELECT order_id, files
		FROM orders
		WHERE user_id = ${userId}
	`;

	let ordersDeleted = 0;
	let filesDeleted = 0;
	let leftovers = 0;

	for (const order of orders)
	{
		const fileIds = Array.isArray(order.files) ? order.files : [];
		const result = await deleteOneOrder({ s3, orderID: order.order_id, userId, fileIds });

		filesDeleted += result.deletedFiles;
		leftovers += result.leftovers;

		if (result.gone)
		{
			ordersDeleted += 1;
		}
	}

	// The database decides what is left, not the loop: orders added meanwhile count too.
	const ordersRemaining = await countAccountOrders(userId);

	if (ordersRemaining > 0 || leftovers > 0)
	{
		return { complete: false, ordersDeleted, filesDeleted, ordersRemaining, leftovers, partiesDeleted: 0 };
	}

	// Both deletes only apply while the account has no orders, so an order created
	// after the count above is never left without its parties or user row.
	const deletedParties = await DB`
		DELETE FROM ordering_parties
		WHERE user_id = ${userId}
			AND NOT EXISTS (SELECT 1 FROM orders WHERE user_id = ${userId})
		RETURNING id
	`;

	await DB`
		DELETE FROM users
		WHERE user_id = ${userId}
			AND NOT EXISTS (SELECT 1 FROM orders WHERE user_id = ${userId})
	`;

	return { complete: true, ordersDeleted, filesDeleted, ordersRemaining: 0, leftovers: 0, partiesDeleted: deletedParties.length };
}
