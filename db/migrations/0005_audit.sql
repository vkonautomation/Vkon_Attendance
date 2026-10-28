-- 0005_audit.sql -- the record of what was done, which must not be editable.
--
-- Attendance data is payroll data, and payroll data that can be rewritten after the
-- fact is not evidence. Two independent layers, because they fail differently:
--
--   1. Privileges. The application role gets INSERT and SELECT and nothing else, so an
--      UPDATE or DELETE from the API is refused by the server before it is planned.
--   2. A trigger that raises. This is the layer that survives a mistake in layer one --
--      including the mistake most likely to happen, which is `npm run db:setup` being
--      re-run after this migration and re-granting DML on every table in the schema. The
--      trigger does not care who you are: it fires for the table owner and for a
--      superuser too, so the append-only rule holds even in a manual psql session.
--
-- Layer one is a policy. Layer two is a fact about the table.

CREATE TABLE audit_log (
  id                 bigserial PRIMARY KEY,
  -- Default now(), and the server's clock rather than a value the caller supplies: an
  -- audit entry whose timestamp can be chosen by the thing being audited is not a
  -- timestamp.
  at                 timestamptz NOT NULL DEFAULT now(),
  -- Nullable on purpose: a sign-in failure has no authenticated actor, and the whole
  -- point of recording it is that somebody who is not an employee tried. Setting
  -- ON DELETE SET NULL rather than CASCADE means removing a departed employee cannot
  -- remove the record of what was done in their name.
  actor_employee_id  uuid REFERENCES employees(id) ON DELETE SET NULL,
  action             text NOT NULL CHECK (action = lower(action) AND action ~ '^[a-z0-9_.]+$'),
  -- text, not uuid: the entity being described is sometimes a settings key or a job
  -- name, and a column that cannot hold those quietly omits them from the audit.
  entity_type        text,
  entity_id          text,
  -- The before/after image, or just the reason. Never a password, a token, or a photo:
  -- what belongs in detail is decided by the caller in lib/audit, which is the one place
  -- that can be tested for it (M10).
  detail             jsonb,
  ip                 text,
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX audit_log_at_idx ON audit_log (at DESC);
CREATE INDEX audit_log_actor_idx ON audit_log (actor_employee_id, at DESC)
  WHERE actor_employee_id IS NOT NULL;
CREATE INDEX audit_log_entity_idx ON audit_log (entity_type, entity_id)
  WHERE entity_type IS NOT NULL;

-- Layer two. The function lives in the schema it protects and does one thing: refuse.
CREATE FUNCTION audit_log_is_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION
    'audit_log is append-only: % is not permitted (attempted by %)',
    TG_OP, current_user
    USING ERRCODE = 'insufficient_privilege', HINT = 'Insert a new entry describing the correction instead of changing history.';
END
$$;

CREATE TRIGGER audit_log_append_only
  BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_is_append_only();

-- A TRUNCATE is not an UPDATE or a DELETE, and it is the fastest way to lose a year of
-- attendance evidence. Row-level triggers never fire for it, so it needs its own
-- statement-level one.
CREATE FUNCTION audit_log_no_truncate() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only: TRUNCATE is not permitted (attempted by %)',
    current_user
    USING ERRCODE = 'insufficient_privilege';
END
$$;

CREATE TRIGGER audit_log_append_only_stmt
  BEFORE TRUNCATE ON audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION audit_log_no_truncate();

-- Layer one, as far as the grants can go here. scripts/db-setup.mjs has already granted
-- SELECT/INSERT/UPDATE/DELETE on all tables to the application role, and the default
-- privileges it installed mean this table would inherit them; so the revocation happens
-- after the table exists, and db-setup re-asserts it on every run.
DO $$
DECLARE role text := COALESCE(current_setting('vkon.app_role', true), 'attendance_app');
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role) THEN
    EXECUTE format('REVOKE UPDATE, DELETE, TRUNCATE ON audit_log FROM %I', role);
    EXECUTE format('GRANT INSERT, SELECT ON audit_log TO %I', role);
    -- Sequence too: id is a bigserial, and UPDATE permission on the sequence would let
    -- a role rewrite which entry is "next", which is the same edit by another name.
    EXECUTE format('REVOKE UPDATE, DELETE ON audit_log_id_seq FROM %I', role);
    EXECUTE format('GRANT USAGE, SELECT ON audit_log_id_seq TO %I', role);
  END IF;
END
$$;

COMMENT ON TABLE audit_log IS
  'Append-only. Enforced by privileges and by a trigger; see 0005_audit.sql.';
COMMENT ON COLUMN audit_log.at IS
  'Server-assigned. Never accepted from a request body.';
