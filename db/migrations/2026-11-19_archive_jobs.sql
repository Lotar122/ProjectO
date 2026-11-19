-- Adds the job queue, worker registry and crash journal used by the native
-- archive worker (projecto-compress). At most one job may be queued or running,
-- enforced by a partial unique index. archive_pending_verify.file_id is text
-- because orders.files is text[].
-- Idempotent: safe to run more than once.

BEGIN;

CREATE TABLE IF NOT EXISTS archive_jobs (
	id            bigserial PRIMARY KEY,
	state         text NOT NULL CHECK (state IN ('queued','running','done','failed','interrupted')),
	triggered_by  text NULL,
	worker_id     text NULL,
	created_at    timestamptz NOT NULL DEFAULT now(),
	started_at    timestamptz NULL,
	finished_at   timestamptz NULL,
	heartbeat_at  timestamptz NULL,
	progress      jsonb NOT NULL DEFAULT '{}'::jsonb,   -- the createStatus() counters + currentFile
	last_error    text NULL
);

-- At most one queued-or-running job, enforced by the database.
CREATE UNIQUE INDEX IF NOT EXISTS archive_jobs_one_active_idx
	ON archive_jobs ((true)) WHERE state IN ('queued','running');

CREATE TABLE IF NOT EXISTS archive_workers (
	worker_id     text PRIMARY KEY,
	version       text NOT NULL,          -- image tag / git sha + projecto-compress --version
	started_at    timestamptz NOT NULL DEFAULT now(),
	heartbeat_at  timestamptz NOT NULL DEFAULT now()
);

-- Crash journal: one row per file whose original is being (or was) replaced
-- and whose read-back has not passed yet. See section 9.
CREATE TABLE IF NOT EXISTS archive_pending_verify (
	file_id          text PRIMARY KEY,     -- same value as the element in orders.files
	job_id           bigint NOT NULL REFERENCES archive_jobs(id),
	method           text NOT NULL CHECK (method IN ('zstd','br')),
	original_sha256  char(64) NOT NULL,
	original_size    bigint NOT NULL,
	stored_size      bigint NOT NULL,
	pre_upload_etag  text NOT NULL,        -- latest.ETag used for If-Match
	stored_etag      text NULL,            -- set after the upload returned
	original_path    text NOT NULL,        -- verified original on /work/tmp
	state            text NOT NULL DEFAULT 'uploading'
	                 CHECK (state IN ('uploading','uploaded','needs_attention')),
	note             text NULL,
	created_at       timestamptz NOT NULL DEFAULT now(),
	updated_at       timestamptz NOT NULL DEFAULT now()
);

COMMIT;

-- rollback: DROP INDEX IF EXISTS archive_jobs_one_active_idx;
--           DROP TABLE IF EXISTS archive_pending_verify;
--           DROP TABLE IF EXISTS archive_workers;
--           DROP TABLE IF EXISTS archive_jobs;
