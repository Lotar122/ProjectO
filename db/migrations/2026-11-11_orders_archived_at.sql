-- Adds orders.archived_at, set by the auto-archiver once all files of an order
-- have been compressed. NULL means "not archived yet". The partial index speeds
-- up picking archive candidates (old orders that are not archived).
-- Idempotent: safe to run more than once.

BEGIN;

ALTER TABLE orders ADD COLUMN IF NOT EXISTS archived_at timestamptz NULL;

CREATE INDEX IF NOT EXISTS orders_archive_candidates_idx
	ON orders (issue_date) WHERE archived_at IS NULL;

COMMIT;

-- rollback: DROP INDEX IF EXISTS orders_archive_candidates_idx;
--           ALTER TABLE orders DROP COLUMN IF EXISTS archived_at;
