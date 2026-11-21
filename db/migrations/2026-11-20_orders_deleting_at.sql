-- Adds orders.deleting_at, the "deletion in progress" marker set by
-- deleteOrderWithFiles (src/app/server-functions/orders/deleteOrderWithFiles.js)
-- in the same transaction that checks the order may be deleted. While it is
-- set, edits, admin status changes and further deletes of the order are refused
-- (409) and the archiver skips the order, so nothing changes the order between
-- that check and the removal of the row. NULL means "not being deleted".
--
-- A separate column instead of a new order_status value: orders.status is the
-- order_status enum, and a new enum value would need a second column to
-- restore the previous status from. Clearing deleting_at leaves the status
-- exactly as it was. A failed deletion clears it again; one that crashed before
-- it could do so leaves it set. A marker older than DELETION_STALE_AFTER_MS
-- (15 minutes, compared against the database clock with now()) no longer
-- counts: edits, admin status changes and archiving proceed again, and a new
-- delete takes the order over and finishes the job.
--
-- Run before deploying the code that uses it: selectOrderForUpdate reads the
-- column, so edits and deletes fail until it exists.
--
-- Idempotent: safe to run more than once. Adding a nullable column without a
-- default does not rewrite the table, but the ALTER needs an ACCESS EXCLUSIVE
-- lock for a moment; lock_timeout makes it give up instead of queueing behind
-- a long transaction (which would stall every order query queued behind it).
-- If it times out, run the file again. No index: the column is only read on
-- rows already found by order_id, and the archive candidate query only checks
-- it on the rows it already selects through orders_archive_candidates_idx.

SET lock_timeout = '5s';

ALTER TABLE orders ADD COLUMN IF NOT EXISTS deleting_at timestamptz NULL;

RESET lock_timeout;

-- rollback: SET lock_timeout = '5s';
--           ALTER TABLE orders DROP COLUMN IF EXISTS deleting_at;
