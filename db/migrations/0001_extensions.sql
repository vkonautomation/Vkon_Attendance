-- 0001_extensions.sql
--
-- Extensions only. This file exists as much to prove the runner as to install
-- something: it is the first migration, so `schema_migrations`, the advisory lock
-- and the per-file transaction all get exercised before there is any application
-- schema that a mistake could damage.
--
-- pgcrypto is here for two reasons, and neither is the one people assume.
-- gen_random_uuid() has been a core function since PostgreSQL 13, so the uuid
-- defaults in 0003_attendance.sql do not need this extension. What does need it is
-- digest(), used by seed and reconciliation SQL that has to hash the same way the
-- Node side hashes (session token hashes, export checksums) without leaving the
-- database. Keeping the two implementations next to each other in review is the
-- point; having them disagree is the bug.
--
-- IF NOT EXISTS because this runs on a database where the superuser may already
-- have installed it, and a migration that fails the second time it runs is worse
-- than no migration at all.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- The ledger the runner maintains. Created here rather than by the runner's own
-- bootstrap so that it is versioned like everything else: the runner's
-- CREATE TABLE IF NOT EXISTS only ever fires on a database that predates this file.
--
-- name is the filename, applied in filename order, and checksum is the sha256 of
-- the file's contents at the moment it ran. A mismatch is not a warning -- the
-- runner refuses to start, because the only explanations are "someone edited
-- history" or "two branches shipped different files with the same name", and both
-- mean the schema in front of it is not the schema any file in the repository
-- describes.
CREATE TABLE IF NOT EXISTS schema_migrations (
  name        text PRIMARY KEY,
  checksum    text NOT NULL,
  applied_at  timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE schema_migrations IS
  'Migrations already applied, with a checksum of the file that applied them.';
