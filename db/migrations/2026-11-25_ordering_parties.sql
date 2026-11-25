-- Adds ordering parties ("zleceniodawcy"): a per-account list of names that an
-- order can be assigned to. An account may have many of them. The names are
-- unique per account, ignoring case.
--
-- user_id is the Kratos identity id, the same value orders.user_id holds. Accounts
-- live in Kratos, not in this database, so user_id has no foreign key, as in the
-- other tables.
--
-- orders gets two nullable columns: ordering_party_id references the party it is
-- assigned to, and ordering_party_name keeps a copy of the name at the time of
-- assignment. ON DELETE SET NULL clears the id when a party is deleted. The copied
-- name is kept, so an order still shows the name it was given. Both columns are
-- NULL for orders without a party.
--
-- Run before deploying the code that uses it: the application reads and writes
-- these tables and columns, so requests fail until they exist. The statements are
-- additive, so the old code ignores them.
--
-- Idempotent: safe to run more than once. The table and the index are new, so the
-- index is built without CONCURRENTLY. The ALTER TABLE on orders adds nullable
-- columns without a default, which does not rewrite the table, but it still takes
-- an ACCESS EXCLUSIVE lock for a moment. lock_timeout makes it give up instead of
-- queueing behind a long transaction. If it times out, run the file again.

SET lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS ordering_parties (
  id          uuid PRIMARY KEY,
  user_id     uuid NOT NULL,
  name        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS ordering_parties_user_name_idx
  ON ordering_parties (user_id, lower(name));

ALTER TABLE orders ADD COLUMN IF NOT EXISTS ordering_party_id uuid NULL
  REFERENCES ordering_parties(id) ON DELETE SET NULL;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS ordering_party_name text NULL;

-- Lookups of the orders assigned to a party, and the ON DELETE SET NULL check when
-- a party is deleted. Plain CREATE INDEX, not CONCURRENTLY: it blocks writes to
-- orders while it builds.
CREATE INDEX IF NOT EXISTS orders_ordering_party_id_idx ON orders (ordering_party_id);

RESET lock_timeout;

-- rollback: SET lock_timeout = '5s';
--           DROP INDEX IF EXISTS orders_ordering_party_id_idx;
--           ALTER TABLE orders DROP COLUMN IF EXISTS ordering_party_name;
--           ALTER TABLE orders DROP COLUMN IF EXISTS ordering_party_id;
--           DROP TABLE IF EXISTS ordering_parties;
--           (drop the columns first: dropping the table while orders still
--           references it fails. Dropping the table removes its rows.)
