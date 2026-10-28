-- 0008_state_documents.sql -- the versioned document store behind the /api/state facade.
--
-- The 22k-line front end keeps its synchronous getStore/setStore API (D1): every shared
-- store is a JSON document keyed by its `vkon_*` localStorage name, and js/api.js bridges
-- it to the server as `GET /api/state` (a projection of all documents + a change counter)
-- and `PUT /api/state/{key}` (one optimistic-concurrency write). This table is that store.
-- It is a transitional shape, retired only when nothing reads it (M11's relational
-- projection), not a design we are choosing over normalised tables -- the normalised data
-- already lives in 0002/0003/0004; this is the document facade the un-changed browser
-- talks to in the meantime.
--
-- One row per document. `version` is the per-key optimistic-concurrency token the browser
-- echoes back as `baseVersion`; a mismatch is the 409 that makes "somebody else changed this
-- first" a fact the tab can act on rather than a silent last-writer-wins.

CREATE TABLE state_documents (
  key         text PRIMARY KEY CHECK (key ~ '^vkon_[a-z0-9_]+$'),
  -- The whole store, exactly as localStorage would hold it. jsonb rather than text so a
  -- corrupt document is refused at INSERT (a json parse error) rather than discovered by
  -- whichever browser reads it next.
  value       jsonb NOT NULL,
  version     bigint NOT NULL DEFAULT 1 CHECK (version >= 1),
  -- Who last changed it, for the audit trail and for a future "locked by" hint. Nullable
  -- and ON DELETE SET NULL: removing a departed employee cannot remove their edits.
  updated_by  uuid REFERENCES employees(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- A single monotonic counter bumped on every successful write. js/api.js `pull()` compares
-- this to decide whether anything changed since the last fetch, so a tab left open notices
-- an approval in one cheap request instead of re-downloading every document. One row, id 1,
-- because two rows that must agree about "how many writes have there been" is a bug.
CREATE TABLE state_meta (
  id          smallint PRIMARY KEY CHECK (id = 1),
  revision    bigint NOT NULL DEFAULT 0 CHECK (revision >= 0),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

INSERT INTO state_meta (id, revision) VALUES (1, 0)
  ON CONFLICT (id) DO NOTHING;

-- The application role gets DML here the moment these tables exist, via the default
-- privileges scripts/db-setup.mjs installed (the same inheritance 0002-0007 rely on); no
-- explicit grant is needed, and -- unlike audit_log -- nothing here is append-only.

COMMENT ON TABLE state_documents IS
  'Document facade (D1): one row per vkon_* shared store. Keyed by key; per-key optimistic concurrency via version. Retired by the M11 relational projection once nothing reads it.';
COMMENT ON COLUMN state_documents.version IS
  'The token the browser echoes as baseVersion. A PUT whose baseVersion is not the current version is a 409, not an overwrite.';
COMMENT ON TABLE state_meta IS
  'Singleton (id = 1) holding the write counter the browser compares in pull().';
