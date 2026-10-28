-- 0004_approvals.sql -- requests, the trail they walk, and what is said about them.
--
-- Every request state column here is the `request_state` domain declared in
-- 0002_core.sql, which is the portal's APPROVAL_STATUSES list spelled as
-- public/shared.js spells it. That is what makes leaves, wfh, regularisations and the
-- approval steps agree with each other by construction instead of by review.

CREATE TABLE leaves (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id  uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  -- 'rh' and 'loss_of_pay' are kinds like any other, so a Restricted Holiday request and
  -- a Loss-of-Pay request take the same path the portal already gives paid leave, and the
  -- difference between them is two columns on leave_kinds rather than a branch in SQL.
  kind_code    text NOT NULL REFERENCES leave_kinds(code),
  from_date    date NOT NULL,
  to_date      date NOT NULL,
  -- half_day is absent on purpose (D5). Whole-day only: the engine already counts a day
  -- at most once (getLopDatesForMonth collapses a 0.5 fraction), so the column would
  -- describe something the rules no longer do. tests/integration/db.mjs asserts the
  -- column is gone, because a schema that silently grows it back is a schema that
  -- reopens a payroll question that was closed by policy.
  reason       text NOT NULL,
  state        request_state NOT NULL DEFAULT 'Pending Manager',
  applied_at   timestamptz NOT NULL DEFAULT now(),
  decided_at   timestamptz,
  decided_by   uuid REFERENCES employees(id) ON DELETE SET NULL,
  cancelled_at timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),

  CHECK (to_date >= from_date),
  -- A decision row without a decider is how "who approved this" becomes unanswerable
  -- after the fact, which is the question an audit is for.
  CHECK (state NOT IN ('Approved', 'Rejected') OR (decided_by IS NOT NULL AND decided_at IS NOT NULL))
);

CREATE INDEX leaves_employee_idx ON leaves (employee_id, from_date DESC);
CREATE INDEX leaves_pending_idx ON leaves (employee_id) WHERE state IN ('Pending Manager', 'Pending Admin');

-- The LOP ledger. The plan's data model names `lop_days` as an integer column; this is
-- the table it belongs on, because the portal keeps LOP as its own document
-- (vkon_lop_entries_v1) with its own duplicate guard, and a projection of that document
-- needs a row per LOP day rather than a flag on whichever request produced it.
--
-- One active entry per employee/day/source, which is exactly addLopEntry()'s guard, and
-- NULLS NOT DISTINCT because the short-hours source carries no refId: two nulls must
-- collide the way the browser's comparison makes them collide.
CREATE TABLE lop_entries (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id  uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  lop_date     date NOT NULL,
  -- Integer, and exactly 1. D5: half-day LOP was removed by policy, so the column cannot
  -- store the thing that was removed. What a month costs is COUNT(DISTINCT lop_date),
  -- which is the same rule getLopDatesForMonth() implements today.
  lop_days     integer NOT NULL DEFAULT 1 CHECK (lop_days = 1),
  source       text NOT NULL CHECK (source IN ('leave', 'short-hours', 'excess', 'import')),
  ref_id       uuid,
  status       text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'cancelled')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  cancelled_at timestamptz
);

CREATE UNIQUE INDEX lop_entries_active_key
  ON lop_entries (employee_id, lop_date, source, ref_id) NULLS NOT DISTINCT
  WHERE status = 'active';
CREATE INDEX lop_entries_month_idx ON lop_entries (employee_id, lop_date);

CREATE TABLE regularisations (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id  uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  target_date  date NOT NULL,
  -- Which half of the day is being claimed, or 'full'. The portal offers missing
  -- check-in, missing check-out and both.
  kind         text NOT NULL CHECK (kind IN ('missing_check_in', 'missing_check_out', 'both')),
  actual_in    time,
  actual_out   time,
  reason       text NOT NULL,
  state        request_state NOT NULL DEFAULT 'Pending Manager',
  applied_at   timestamptz NOT NULL DEFAULT now(),
  decided_at   timestamptz,
  decided_by   uuid REFERENCES employees(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),

  CHECK (actual_out IS NULL OR actual_in IS NULL OR actual_out >= actual_in),
  CHECK (state NOT IN ('Approved', 'Rejected') OR (decided_by IS NOT NULL AND decided_at IS NOT NULL)),
  -- A claim has to claim something. "Missing check-in" without an actual in-time is a
  -- request that cannot be approved into a day, and the portal lets it be typed; the
  -- server should not store it.
  CHECK (
    (kind = 'missing_check_in'  AND actual_in  IS NOT NULL) OR
    (kind = 'missing_check_out' AND actual_out IS NOT NULL) OR
    (kind = 'both'              AND actual_in IS NOT NULL AND actual_out IS NOT NULL)
  )
);

-- One open claim per employee per day. Re-applying after a rejection has to be possible,
-- so a rejected or cancelled claim is history rather than a lock, which is why this is a
-- partial unique index and not a table constraint on (employee_id, target_date).
CREATE UNIQUE INDEX regularisations_open_one
  ON regularisations (employee_id, target_date)
  WHERE state IN ('Pending Manager', 'Pending Admin', 'Cancellation Requested');

CREATE INDEX regularisations_pending_idx ON regularisations (employee_id)
  WHERE state IN ('Pending Manager', 'Pending Admin');

-- Configurable routing, one row per request type. A table, not the jsonb blob the
-- portal stores, because approval routing is read on the hot path of every decision and
-- must be joinable -- "what happens to this request next" is a query, not a parse.
CREATE TABLE approval_flow (
  entity_type  text PRIMARY KEY CHECK (entity_type IN ('leave', 'wfh', 'regularisation', 'lop')),
  route        text NOT NULL CHECK (route IN ('manager_only', 'manager_then_admin')),
  -- How many steps the route implies, so a step row can be validated against it without
  -- the application being the only place that knows manager_then_admin means two.
  steps        smallint NOT NULL CHECK (steps IN (1, 2)),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

-- The decision trail. `unique(entity_type, entity_id, step)` is the constraint that
-- matters: a request walks manager -> (admin fallback) in order, and without it the same
-- request can be approved twice at one step by two people, or out of order by someone
-- who skips a step. Both are invisible until payroll.
CREATE TABLE approvals (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type  text NOT NULL CHECK (entity_type IN ('leave', 'wfh', 'regularisation', 'lop')),
  entity_id    uuid NOT NULL,
  step         smallint NOT NULL CHECK (step >= 1),
  approver_id  uuid REFERENCES employees(id) ON DELETE SET NULL,
  state        request_state NOT NULL,
  comment      text,
  decided_at   timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),

  UNIQUE (entity_type, entity_id, step),
  CHECK (step <= 2),
  CHECK (state NOT IN ('Approved', 'Rejected') OR approver_id IS NOT NULL)
);

CREATE INDEX approvals_entity_idx ON approvals (entity_type, entity_id, step);

-- Notifications. Per-user read state lives here rather than in a browser key, because the
-- portal's vkon_regalert_seen_v1 is one timestamp per device: read a reminder on the
-- phone, and the laptop still says it is unseen. The projection can still produce that
-- document -- MAX(occurred_at) over read rows is the same number -- but it is no longer
-- the only record of it, and it is no longer the authority.
CREATE TABLE notifications (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id  uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  kind         text NOT NULL,
  severity     text NOT NULL DEFAULT 'info' CHECK (severity IN ('info', 'warn', 'urgent')),
  title        text NOT NULL,
  body         text NOT NULL,
  entity_type  text,
  entity_id    uuid,
  occurred_at  timestamptz NOT NULL DEFAULT now(),
  read_at      timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),

  -- entity_type and entity_id travel together: one without the other is a notification
  -- that links nowhere, and the screen turns it into a dead row.
  CHECK ((entity_type IS NULL) = (entity_id IS NULL))
);

CREATE INDEX notifications_unread_idx ON notifications (employee_id, occurred_at DESC)
  WHERE read_at IS NULL;
CREATE INDEX notifications_employee_idx ON notifications (employee_id, occurred_at DESC);

DO $$
DECLARE t record;
BEGIN
  FOR t IN
    SELECT c.relname FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind = 'r'
       AND c.relname IN ('leaves', 'lop_entries', 'regularisations', 'approval_flow')
  LOOP
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION set_updated_at()',
      'set_updated_at_' || t.relname, t.relname);
  END LOOP;
END
$$;

INSERT INTO approval_flow (entity_type, route, steps) VALUES
  ('leave',          'manager_only',       1),
  ('wfh',            'manager_only',       1),
  ('regularisation', 'manager_only',       1),
  ('lop',            'manager_then_admin', 2)
ON CONFLICT (entity_type) DO NOTHING;

COMMENT ON TABLE approvals IS
  'One row per (entity, step): a request cannot be decided twice at one step.';
COMMENT ON COLUMN lop_entries.lop_days IS
  'Always 1 (D5). A month is COUNT(DISTINCT lop_date), never SUM(lop_days).';
