-- fixture 0002_beta.sql -- completes the good set.
CREATE TABLE fixture_beta (
  id          int PRIMARY KEY,
  note        text
);

INSERT INTO fixture_beta (id, note) VALUES (1, 'the good set applies cleanly');
