-- Adds orders.archived_at, set by the auto-archiver once all files of an order
-- have been compressed. NULL means "not archived yet". The partial index speeds
-- up picking archive candidates (old orders that are not archived).
-- Idempotent: safe to run more than once.
--
-- Not wrapped in a transaction: CREATE INDEX CONCURRENTLY refuses to run inside
-- one. Run it with scripts/migrate-orders-archived-at.mjs, or with psql (which
-- sends each statement on its own). Do not paste it into a client that wraps
-- the whole file in BEGIN ... COMMIT.
--
-- The ALTER needs an ACCESS EXCLUSIVE lock for a moment (adding a nullable
-- column without a default does not rewrite the table). lock_timeout makes it
-- give up instead of queueing behind a long transaction, which would stall
-- every order query queued behind it. If it times out, run the file again.
--
-- If the CREATE INDEX CONCURRENTLY fails, it leaves an invalid index behind
-- that IF NOT EXISTS would skip. The script drops it first; by hand, run
-- DROP INDEX CONCURRENTLY IF EXISTS orders_archive_candidates_idx; and retry.

SET lock_timeout = '5s';

ALTER TABLE orders ADD COLUMN IF NOT EXISTS archived_at timestamptz NULL;

-- The concurrent build waits for older transactions but does not block reads
-- or writes while it does, so it runs without the short lock_timeout.
RESET lock_timeout;

CREATE INDEX CONCURRENTLY IF NOT EXISTS orders_archive_candidates_idx
	ON orders (issue_date) WHERE archived_at IS NULL;

-- rollback: DROP INDEX CONCURRENTLY IF EXISTS orders_archive_candidates_idx;
--           SET lock_timeout = '5s';
--           ALTER TABLE orders DROP COLUMN IF EXISTS archived_at;
