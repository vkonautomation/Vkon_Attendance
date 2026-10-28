-- fixture 0001_alpha.sql -- same name, different file. The drift fixture.
--
-- The runner stores a checksum of what it applied, and this file exists to be the
-- thing that trips it: "I just edited the migration that already ran on staging" is
-- not recoverable by inspection, because a name tells you a file was applied and
-- nothing tells you the schema matches the file now sitting in the checkout. The
-- runner has to refuse rather than skip it silently or try to work out the difference.
--
-- `source` is the added column. Byte-for-byte this is not what 0001_alpha.sql said in
-- the good set, which is the whole point.
CREATE TABLE fixture_alpha (
  id          int PRIMARY KEY,
  label       text NOT NULL DEFAULT 'alpha',
  source      text NOT NULL DEFAULT 'edited after it ran'
);
