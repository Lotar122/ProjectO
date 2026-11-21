-- Follow-up to 2026-11-19_archive_jobs.sql, which may already be applied and
-- is therefore not edited.
--
-- 1. archive_pending_verify.job_id gets an explicit ON DELETE RESTRICT. The
--    earlier foreign key (no ON DELETE clause, so NO ACTION) already refused
--    such deletes, so this makes the intent explicit rather than changing
--    behavior. A crash journal row is the only record of an original that
--    may not be verified or restored yet, so a job must never take its
--    journal rows with it:
--    deleting an archive_jobs row fails while any archive_pending_verify row
--    still references it. To delete a job, first resolve its journal rows
--    (let the worker finish or restore them, or check 'needs_attention' rows
--    by hand) and delete them, then delete the job.
-- 2. archive_pending_verify.job_id gets an index, so that the RESTRICT check
--    (and any lookup by job) does not scan the whole journal for every
--    deleted job. This is the practical change of this migration.
--
-- Idempotent: safe to run more than once. Not wrapped in one transaction,
-- because CREATE INDEX CONCURRENTLY refuses to run inside one. Run it with
-- scripts/migrate-archive-jobs.mjs, or with psql.

SET lock_timeout = '5s';

-- Replaces every foreign key from archive_pending_verify to archive_jobs that
-- is not ON DELETE RESTRICT (the one from 2026-11-19 is unnamed, so its name is
-- looked up rather than assumed), then adds the restricting one if it is not
-- there yet. A DO block is one statement, so the swap is atomic.
DO $$
DECLARE
	fk record;
BEGIN
	FOR fk IN
		SELECT conname
		FROM pg_constraint
		WHERE conrelid = 'archive_pending_verify'::regclass
			AND confrelid = 'archive_jobs'::regclass
			AND contype = 'f'
			AND confdeltype <> 'r'
	LOOP
		EXECUTE format('ALTER TABLE archive_pending_verify DROP CONSTRAINT %I', fk.conname);
	END LOOP;

	IF NOT EXISTS (
		SELECT 1
		FROM pg_constraint
		WHERE conrelid = 'archive_pending_verify'::regclass
			AND confrelid = 'archive_jobs'::regclass
			AND contype = 'f'
			AND confdeltype = 'r'
	)
	THEN
		ALTER TABLE archive_pending_verify
			ADD CONSTRAINT archive_pending_verify_job_id_fkey
			FOREIGN KEY (job_id) REFERENCES archive_jobs (id) ON DELETE RESTRICT;
	END IF;
END
$$;

RESET lock_timeout;

-- If this build fails it leaves an invalid index that IF NOT EXISTS would skip.
-- The script drops it first; by hand, run
-- DROP INDEX CONCURRENTLY IF EXISTS archive_pending_verify_job_id_idx; and retry.
CREATE INDEX CONCURRENTLY IF NOT EXISTS archive_pending_verify_job_id_idx
	ON archive_pending_verify (job_id);

-- rollback: DROP INDEX CONCURRENTLY IF EXISTS archive_pending_verify_job_id_idx;
--           ALTER TABLE archive_pending_verify DROP CONSTRAINT IF EXISTS archive_pending_verify_job_id_fkey;
--           ALTER TABLE archive_pending_verify ADD CONSTRAINT archive_pending_verify_job_id_fkey
--               FOREIGN KEY (job_id) REFERENCES archive_jobs (id);
