-- fixture 0002_broken.sql -- fails halfway, on purpose.
--
-- This is the M1 test for "a failing migration rolls back and leaves the schema at
-- the previous version". It matters because the tempting runner design executes each
-- statement as it arrives, which on a real deploy means the table from line 1 exists
-- while the constraint from line 4 does not, and the next person to look at the
-- database is debugging a schema that no file in the repository describes.
--
-- The CREATE TABLE below must not survive the run. Neither must the ledger row for
-- this file, which is why the runner writes it inside the same transaction.

CREATE TABLE fixture_broken (
  id          int PRIMARY KEY,
  value       text NOT NULL
);

INSERT INTO fixture_broken (id, value) VALUES (1, 'written before the failure');

-- Portable across PostgreSQL 13..17 and unambiguously an error rather than a
-- parse failure, so what is being tested is the rollback and not the parser.
DO $$
BEGIN
  RAISE EXCEPTION 'intentional fixture failure: 0002_broken.sql always raises';
END
$$;
