-- fixture 0001_alpha.sql -- the migration that always succeeds.
-- Applied first by both the good set and the bad set, so "the schema is left at the
-- previous version" has something to be left at.
CREATE TABLE fixture_alpha (
  id          int PRIMARY KEY,
  label       text NOT NULL DEFAULT 'alpha'
);
