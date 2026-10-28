-- 0002_core.sql -- the people, their logins, the things they configure.
--
-- Dates that mean "an attendance day" are `date` columns, computed in Asia/Kolkata by
-- the server and never accepted from a browser. This file is where that rule starts:
-- nothing here stores an attendance day as text or as a timestamp the client chose.
--
-- Every table carries created_at/updated_at. updated_at is maintained by a trigger
-- rather than by each writer remembering to set it, because a column that is wrong
-- whenever somebody forgets is worse than no column: it looks authoritative.

-- Shared vocabulary, declared once, before the tables that use it -- including the
-- attendance tables in 0003, which is why it lives here rather than with the approval
-- tables in 0004.
--
-- It is the portal's own state list, spelled the same way: APPROVAL_STATUSES in
-- public/shared.js is ["Pending Manager", "Pending Admin", "Approved", "Rejected",
-- "Cancelled", "Cancellation Requested"], and D1 requires GET /api/state to hand back
-- exactly what the front end reads today. A prettier internal vocabulary would need a
-- translation table on every read, and translation tables are where drift lives.
--
-- A domain rather than an enum type: a domain can be widened with ALTER DOMAIN inside a
-- transaction, which is the one thing a migration here always has.
CREATE DOMAIN request_state AS text
  CHECK (VALUE IN ('Pending Manager', 'Pending Admin', 'Approved', 'Rejected',
                   'Cancelled', 'Cancellation Requested'));

CREATE TABLE employees (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- What the portal calls `id` ("EMP001") and what a payslip carries. Distinct from
  -- the uuid, which the portal never sees: an internal surrogate key leaking into an
  -- export is a key nobody can renumber later.
  employee_code         text NOT NULL,
  username              text NOT NULL,
  name                  text NOT NULL,
  email                 text,

  -- The portal's `role` field is a job title ("Senior Full-Stack Engineer"), and it is
  -- what a screen displays. What may sign in, and what may approve, is `role` below.
  -- Two different ideas were living in one browser field; the schema separates them and
  -- the projection in M6 puts the job title back where the front end reads it.
  job_title             text,
  department            text,
  role                  text NOT NULL DEFAULT 'employee'
                        CHECK (role IN ('employee', 'manager', 'admin')),

  -- Self-referencing on purpose: an employee's manager must exist before that
  -- manager's own manager does, so a chain is built from the top down in any order.
  -- Depth-1 cycles are refused here; the full chain check is a constraint trigger at
  -- M7, where the code that walks it exists.
  manager_id            uuid REFERENCES employees(id) ON DELETE SET NULL,

  monthly_salary        numeric(12,2) CHECK (monthly_salary >= 0),
  geofence_enabled      boolean NOT NULL DEFAULT true,

  -- False until enrolment finishes. The point of storing it: requireSession() checks
  -- this on every request, so deactivating someone takes effect on their next one
  -- rather than at their next login, which may never come.
  active                boolean NOT NULL DEFAULT false,

  password_hash         text,
  password_changed_at   timestamptz,
  -- js/api.js treats 403 + reason "password_change_required" as "you may not read
  -- anything until you pick a new password", which is how a generated first password
  -- stops being a permanent one. The flag has to live server-side; a browser-side
  -- flag is a flag the browser can delete.
  password_change_required boolean NOT NULL DEFAULT false,

  failed_attempts       integer NOT NULL DEFAULT 0 CHECK (failed_attempts >= 0),
  locked_until          timestamptz,

  joined_on             date,
  -- Fixed offset, no DST. Stored per employee so a future office outside India is a
  -- row change rather than a rewrite of the day-boundary code.
  timezone              text NOT NULL DEFAULT 'Asia/Kolkata',

  -- The master baseline portrait the biometric comparison reads. A path or a data
  -- reference, never the bytes: a 200x200 SVG in a text column ends up in every
  -- projection of every employee list.
  avatar_path           text,

  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),

  CHECK (employee_code = upper(employee_code)),
  CHECK (username = lower(username)),
  CHECK (email IS NULL OR email ~* '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'),
  CHECK (manager_id IS NULL OR manager_id <> id),
  CHECK (password_hash IS NULL OR length(password_hash) > 0)
);

CREATE UNIQUE INDEX employees_employee_code_key ON employees (employee_code);
CREATE UNIQUE INDEX employees_username_key ON employees (username);
CREATE UNIQUE INDEX employees_email_key ON employees (email) WHERE email IS NOT NULL;
-- The manager chain is walked on every approval routing decision, and "who reports to
-- me" is the query a manager's screen runs.
CREATE INDEX employees_manager_id_idx ON employees (manager_id) WHERE manager_id IS NOT NULL;
CREATE INDEX employees_active_idx ON employees (active) WHERE active;

-- A session row is the whole authentication decision. Nothing about the identity is
-- stored in the cookie, so nothing in the cookie can be edited.
CREATE TABLE sessions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id    uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,

  -- SHA-256 of the cookie value, and the only copy the server keeps. A database leak
  -- must not be enough to forge a live cookie; the value that would be replayed was
  -- never written down. The check is here because a truncated or non-hex hash means a
  -- caller hashed with the wrong algorithm, which fails open in exactly one way.
  token_hash     text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),

  created_at     timestamptz NOT NULL DEFAULT now(),
  last_seen_at   timestamptz NOT NULL DEFAULT now(),
  -- The idle deadline, extended on activity. The absolute deadline is derived from
  -- created_at rather than stored: two columns that must agree are two columns that
  -- eventually will not, and "36h from created_at" is the only rule.
  expires_at     timestamptz NOT NULL,
  revoked_at     timestamptz,

  ip_cidr        text,
  user_agent     text
);

CREATE INDEX sessions_expiry_idx ON sessions (expires_at) WHERE revoked_at IS NULL;
CREATE INDEX sessions_employee_idx ON sessions (employee_id);

-- Leave kinds are a table, not a jsonb blob, because rule code joins them on the hot
-- path: quota remaining, whether a day is paid, whether an approved request produces
-- LOP. The browser key is kept alongside so the projection can rebuild the document
-- the front end reads today without a rename table in JavaScript.
--
-- Two browser keys, because the portal has two different strings for one kind and both
-- are load-bearing: `category` is what a request carries ("Personal Leave", "RH",
-- "LossOfPay") and the quota document is keyed by a camelCase field name
-- ("personalLeave", "restrictedLeave"). Naming them here rather than in a JavaScript
-- switch is the difference between one list and two that can disagree.
--
-- The PL/EL/CL split and the numbers on it are an HR question that is still open (Q4).
-- The shape is not: adding a kind is an INSERT, not a migration.
CREATE TABLE leave_kinds (
  code              text PRIMARY KEY CHECK (code = lower(code)),
  name              text NOT NULL,
  browser_category  text UNIQUE,
  quota_key         text UNIQUE,
  paid              boolean NOT NULL DEFAULT true,
  counts_as_lop     boolean NOT NULL DEFAULT false,
  requires_proof    boolean NOT NULL DEFAULT false,
  annual_quota      integer CHECK (annual_quota >= 0),
  active            boolean NOT NULL DEFAULT true,
  sort_order        integer NOT NULL DEFAULT 0,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

-- One row per setting key, value as jsonb. This is where the portal's `vkon_settings_v6`,
-- `vkon_min_work_policy_v6`, `vkon_short_leave_settings_v6` and `vkon_leave_quotas_v6`
-- documents land: payroll cut-off day, geofence radius and the accuracy gates, minimum
-- working hours, short-leave thresholds, holiday work mode. jsonb rather than a column
-- per knob because the knobs are the front end's, and renaming one should not be a
-- migration.
--
-- The check constraints that matter live in the code that reads them (M9), which is a
-- deliberate weakening: a schema cannot express "cut-off day is 1..28 *and* is not
-- after the last day of the shortest month" as well as the rule module can, and the
-- rule module is what both sides are conformance-tested against in M5.
CREATE TABLE settings (
  key         text PRIMARY KEY CHECK (key = lower(key) AND key ~ '^[a-z0-9_.:]+$'),
  value       jsonb NOT NULL,
  updated_by  uuid REFERENCES employees(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- The idempotency record for scheduled jobs. `unique(job, bucket_date)` is the whole
-- design: a cron entry that fires twice, or a manual re-run after a failed deploy,
-- becomes a no-op instead of a second notification to the same person. Lives here
-- rather than in 0004 because it is operational state, not approval state, and it is
-- created before the first job exists so the jobs in M10 can rely on it.
CREATE TABLE job_runs (
  job           text NOT NULL,
  bucket_date   date NOT NULL,
  started_at    timestamptz NOT NULL DEFAULT now(),
  finished_at   timestamptz,
  rows_affected integer NOT NULL DEFAULT 0 CHECK (rows_affected >= 0),
  detail        jsonb,
  PRIMARY KEY (job, bucket_date)
);

-- updated_at, maintained by the database.
CREATE FUNCTION set_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END
$$;

DO $$
DECLARE t record;
BEGIN
  FOR t IN
    SELECT c.relname FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind = 'r'
       AND c.relname IN ('employees', 'settings', 'leave_kinds')
  LOOP
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION set_updated_at()',
      'set_updated_at_' || t.relname, t.relname);
  END LOOP;
END
$$;

COMMENT ON TABLE employees IS
  'The roster. `role` authorises, `job_title` displays; active gates every request.';
COMMENT ON COLUMN sessions.token_hash IS
  'sha256 hex of the cookie value. The value itself is never stored.';
COMMENT ON COLUMN sessions.expires_at IS
  'Idle deadline. The absolute deadline is created_at + the configured maximum.';
