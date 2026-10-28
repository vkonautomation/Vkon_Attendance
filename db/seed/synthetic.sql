-- db/seed/synthetic.sql -- reference data and a throwaway roster. No real anything.
--
-- This file is committed to a public repository and is the seed a development database
-- runs. So it is written to be *obviously* fake rather than plausibly fake: every name
-- is a letter and a role, every email is at example.test (a reserved domain that cannot
-- receive mail), every code is EMPnnn, and there is no password anywhere in it. The
-- public-repo guard test (tests/guard.mjs) enforces exactly those rules and fails the
-- build if this file ever grows a real credential, a real-looking email domain, or a name
-- lifted from the portal's demo roster -- because "we were careful" is not a control.
--
-- Nothing here is the production roster. Real names arrive as a private hand-off to the
-- deploy host and are never committed (plan, "Public repository rules").
--
-- Idempotent by construction, in the one way that is safe: reference data is upserted
-- (it is this file's job to be right), and anything a person could have edited is
-- insert-only (it is not this file's job to overwrite it). Re-running is a no-op, which
-- is what makes it usable from a Makefile, a compose entrypoint, or a fresh clone.
--
-- No password is set for any seeded employee. An account with no password_hash cannot
-- sign in at all, which is the correct state for a synthetic roster and the only state
-- that cannot accidentally become a default credential. The admin bootstrap -- generate
-- one, print it once, force a change on first sign-in -- arrives with bcrypt in M3.
--
-- No BEGIN/COMMIT here: the caller owns the transaction, so a half-applied seed is
-- impossible whether it runs through `npm run db:seed` or by hand as
-- `psql -1 -f db/seed/synthetic.sql`. A file that opens its own transaction inside the
-- runner's produces a warning on stderr and a question nobody wants to answer during a
-- deploy.

-- ---------------------------------------------------------------- leave kinds
-- browser_category is the string a request carries today ("Personal Leave", "RH",
-- "LossOfPay"); quota_key is the field the quota document is keyed by. The PL/EL/CL
-- split and its numbers are still an HR question (Q4); the shape is settled, so adding a
-- kind later is an INSERT here and nothing else.
INSERT INTO leave_kinds
  (code, name, browser_category, quota_key, paid, counts_as_lop, requires_proof, annual_quota, sort_order)
VALUES
  ('personal_leave',  'Personal Leave',         'Personal Leave', 'personalLeave',  true,  false, false, 14, 10),
  ('sick_leave',      'Sick Leave',             'Sick Leave',     NULL,             true,  false, false,  0, 20),
  ('casual_leave',    'Casual Leave',           'Casual Leave',   NULL,             true,  false, false,  0, 30),
  ('restricted',      'Restricted Holiday',     'RH',             'restrictedLeave', true, false, false,  2, 40),
  ('loss_of_pay',     'Loss of Pay',            'LossOfPay',      NULL,             false, true,  false,  0, 50)
ON CONFLICT (code) DO UPDATE SET
  name             = EXCLUDED.name,
  browser_category = EXCLUDED.browser_category,
  quota_key        = EXCLUDED.quota_key,
  paid             = EXCLUDED.paid,
  counts_as_lop    = EXCLUDED.counts_as_lop,
  annual_quota     = EXCLUDED.annual_quota,
  sort_order       = EXCLUDED.sort_order;

-- ------------------------------------------------------------------ settings
-- Insert-only. An administrator changing a policy is the normal case, and a seed that
-- resets it is a seed that quietly undoes someone's work on the next `make dev`.
INSERT INTO settings (key, value) VALUES
  ('attendance.short_leave', jsonb_build_object(
     'requiredHours', 9,
     'minPresentHours', 8,
     'payrollCutOffDay', 1,
     'shiftStart', '09:30 AM',
     'graceMinutes', 15,
     'lateFrom', 'shiftStart',
     'treatWeekendsAsNonWorking', false,
     'holidayWorkMode', 'compoff')),
  ('attendance.min_work_policy', jsonb_build_object(
     'hours', 8, 'minutes', 0, 'totalMinutes', 480)),
  ('leave.quotas', jsonb_build_object(
     'personalLeave', 14, 'restrictedLeave', 2,
     'annualAllowance', 14, 'weeklyWfhAllowance', 2, 'monthlyRhAllowance', 2)),
  ('geofence.office', jsonb_build_object(
     'name', 'VKON Automation Tech Park', 'lat', 12.9716, 'lng', 77.5946,
     -- 500 m is what the portal enforces today. The accuracy gates (strict for a GPS
     -- fix, a fairer threshold for a network-positioned device) are an HR number that
     -- has not been signed off (Q4), so they are deliberately absent rather than
     -- invented here: a placeholder in a seed becomes a production default.
     'radiusMeters', 500)),
  ('payroll', jsonb_build_object(
     'cutOffDay', 1,
     -- A flat 30, not calendar days, exactly as LOP_PER_DAY_DIVISOR does today. Pending
     -- confirmation (Q4); it is a load-bearing number and 50000/30*3 must equal 5000.00.
     'perDayDivisor', 30))
ON CONFLICT (key) DO NOTHING;

-- ------------------------------------------------------------------ holidays
-- The declared/restricted distinction is the point of this block: getDeclaredHolidays()
-- excludes Restricted Holidays from the set that suppresses LOP, so a seed that made both
-- rows look the same would hide a rule in data.
INSERT INTO holidays (code, holiday_date, name, kind) VALUES
  ('HOL-01', '2026-10-02', 'Gandhi Jayanti',         'declared'),
  ('HOL-02', '2026-10-20', 'Diwali Festival',        'restricted'),
  ('HOL-03', '2026-10-21', 'Ayudha Puja / Dussehra', 'restricted'),
  ('HOL-04', '2026-12-25', 'Christmas Day',          'declared'),
  ('HOL-05', '2026-01-26', 'Republic Day',           'declared'),
  ('HOL-06', '2026-08-15', 'Independence Day',       'declared')
ON CONFLICT (code) DO UPDATE SET
  holiday_date = EXCLUDED.holiday_date,
  name         = EXCLUDED.name,
  kind         = EXCLUDED.kind,
  active       = TRUE;

-- ---------------------------------------------------------------- employees
-- A chain, not a flat list: tester_d reports to tester_b, who reports to tester_c. The
-- self-referencing manager_id is only interesting once it is actually walked, and M7's
-- tests need a two-level chain to route an approval through.
INSERT INTO employees
  (employee_code, username, name, email, job_title, department, role, manager_id,
   monthly_salary, geofence_enabled, active, joined_on, timezone)
VALUES
  ('EMP001', 'tester_a', 'A Tester',   'tester_a@example.test', 'Test Engineer',        'Engineering', 'employee', NULL,
   50000.00, TRUE,  TRUE,  '2026-01-10', 'Asia/Kolkata'),
  ('EMP002', 'tester_b', 'B Tester',   'tester_b@example.test', 'Test Designer',        'Product',     'employee', NULL,
   42000.00, TRUE,  TRUE,  '2026-02-15', 'Asia/Kolkata'),
  ('EMP003', 'tester_c', 'C Manager',  'tester_c@example.test', 'Engineering Manager',  'Operations',  'manager',  NULL,
   68000.00, FALSE, TRUE,  '2026-01-05', 'Asia/Kolkata'),
  ('EMP004', 'tester_d', 'D Intern',   'tester_d@example.test', 'Test Intern',          'Engineering', 'employee', NULL,
   18000.00, TRUE,  TRUE,  '2026-03-01', 'Asia/Kolkata')
ON CONFLICT (employee_code) DO UPDATE SET
  name           = EXCLUDED.name,
  email          = EXCLUDED.email,
  job_title      = EXCLUDED.job_title,
  department     = EXCLUDED.department,
  timezone       = EXCLUDED.timezone,
  updated_at     = now();

-- manager_id after the fact, because the chain needs both ends to exist first -- the
-- same reason the foreign key is self-referencing and nullable rather than deferred.
UPDATE employees SET manager_id = e.id
  FROM (SELECT id, employee_code FROM employees WHERE employee_code IN ('EMP001','EMP002','EMP003','EMP004')) AS e
 WHERE employees.employee_code IN ('EMP001','EMP002','EMP004')
   AND e.employee_code = 'EMP003';

-- The one employee who is not active. Everything in M3 that gates access on `active`
-- needs a row that is false, and a test that flips a real row to make one will be
-- deleted the next time the seed is trusted.
INSERT INTO employees
  (employee_code, username, name, email, job_title, department, role,
   monthly_salary, geofence_enabled, active, joined_on, timezone)
VALUES
  ('EMP005', 'tester_e', 'E Ex-Tester', 'tester_e@example.test', 'Former Test Engineer',
   'Engineering', 'employee', 30000.00, TRUE, FALSE, '2025-06-01', 'Asia/Kolkata')
ON CONFLICT (employee_code) DO NOTHING;

-- ------------------------------------------------- attendance days for one month
-- Two days worth of punched history for 2026-10, chosen to exercise rules rather than to
-- look like a month: a clean full day, a short day, a day whose GPS fix is outside the
-- geofence, an open shift with no check-out (midnight rollover's input), and a WFH day.
--
-- Timestamps carry the +05:30 offset explicitly. attendance_day is the IST calendar day
-- and is written here rather than derived, so a change to the server's timezone cannot
-- move a seeded day and make a fixture disagree with itself.
INSERT INTO records
  (employee_id, attendance_day, check_in_at, check_out_at,
   check_in_lat, check_in_lng, check_in_accuracy_m,
   check_out_lat, check_out_lng, check_out_accuracy_m,
   source, status, location_type, biometric_verified)
SELECT e.id, r.attendance_day, r.check_in_at, r.check_out_at,
       r.check_in_lat, r.check_in_lng, r.check_in_accuracy_m,
       r.check_out_lat, r.check_out_lng, r.check_out_accuracy_m,
       r.source, r.status, r.location_type, r.biometric_verified
  FROM (VALUES
    ('EMP001'::text, '2026-10-05'::date,
      '2026-10-05T09:20:00+05:30'::timestamptz, '2026-10-05T18:35:00+05:30'::timestamptz,
      12.9719::double precision, 77.5943::double precision, 12.0::numeric(8,2),
      12.9718, 77.5944, 15.0,
      'punch'::text, 'Present'::text, 'Office'::text, TRUE),
    ('EMP001', '2026-10-06',
      '2026-10-06T09:25:00+05:30', '2026-10-06T16:10:00+05:30',
      12.9720, 77.5942, 18.0,
      12.9720, 77.5942, 20.0,
      'punch', 'Present', 'Office', TRUE),
    -- Outside the 500 m radius. Whether this is refused is a server-side decision (M6)
    -- made from these numbers, so the numbers have to be in the row, not a verdict.
    ('EMP002', '2026-10-06',
      '2026-10-06T09:40:00+05:30', '2026-10-06T18:20:00+05:30',
      12.9850, 77.6100, 45.0,
      12.9850, 77.6100, 40.0,
      'punch', 'Present', 'Office', FALSE),
    -- Open shift: the input the midnight-rollover test needs.
    ('EMP001', '2026-10-09',
      '2026-10-09T22:15:00+05:30', NULL,
      12.9717, 77.5945, 10.0,
      NULL, NULL, NULL,
      'punch', 'Present', 'Office', TRUE),
    ('EMP004', '2026-10-07',
      NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
      'wfh', 'WFH', 'Work From Home (Approved)', NULL)
  ) AS r(employee_code, attendance_day, check_in_at, check_out_at,
         check_in_lat, check_in_lng, check_in_accuracy_m,
         check_out_lat, check_out_lng, check_out_accuracy_m,
         source, status, location_type, biometric_verified)
  JOIN employees e ON e.employee_code = r.employee_code
ON CONFLICT (employee_id, attendance_day) DO NOTHING;

-- ---------------------------------------------- requests, and what they decided
INSERT INTO leaves (employee_id, kind_code, from_date, to_date, reason, state,
                    applied_at, decided_at, decided_by)
SELECT e.id, 'personal_leave', '2026-10-19', '2026-10-20',
       'Family function (synthetic)', 'Approved',
       '2026-10-12T10:00:00+05:30', '2026-10-13T11:30:00+05:30', m.id
  FROM employees e, employees m
 WHERE e.employee_code = 'EMP002' AND m.employee_code = 'EMP003'
   AND NOT (EXISTS (SELECT 1 FROM leaves l WHERE l.employee_id = e.id
                      AND l.from_date = '2026-10-19' AND l.kind_code = 'personal_leave'));

INSERT INTO wfh (employee_id, work_day, reason, plan, state, decided_at, decided_by)
SELECT e.id, '2026-10-07', 'Delivery window at home (synthetic)',
       'Full day, reachable on Slack', 'Approved',
       '2026-10-06T17:00:00+05:30', m.id
  FROM employees e, employees m
 WHERE e.employee_code = 'EMP004' AND m.employee_code = 'EMP003'
ON CONFLICT (employee_id, work_day) DO NOTHING;

INSERT INTO regularisations (employee_id, target_date, kind, actual_in, actual_out,
                             reason, state, applied_at)
SELECT e.id, '2026-10-08', 'missing_check_out', '09:05:00'::time, '18:05:00'::time,
       'Punch-out hardware fault (synthetic)', 'Pending Manager', '2026-10-09T09:00:00+05:30'
  FROM employees e WHERE e.employee_code = 'EMP001'
-- The conflict target has to name the partial index's predicate: the uniqueness rule on
-- regularisations is partial (one open claim per day), and ON CONFLICT cannot infer an
-- index whose WHERE clause is not spelled out.
ON CONFLICT (employee_id, target_date)
  WHERE state IN ('Pending Manager', 'Pending Admin', 'Cancellation Requested')
  DO NOTHING;

-- A whole-day LOP entry, which is all D5 permits: lop_days is 1 and a month counts
-- distinct dates, never a sum of fractions.
INSERT INTO lop_entries (employee_id, lop_date, lop_days, source)
SELECT e.id, '2026-10-30', 1, 'short-hours'
  FROM employees e WHERE e.employee_code = 'EMP001'
ON CONFLICT DO NOTHING;

-- One audit entry, so the append-only tests have something that predates them and do not
-- have to write a row first -- writing it would mean the test proved it could insert, not
-- that it cannot edit.
INSERT INTO audit_log (action, entity_type, entity_id, detail, ip)
SELECT 'seed.synthetic', 'database', 'vkon-attendance',
       jsonb_build_object('note', 'reference data loaded by db/seed/synthetic.sql'), NULL
 WHERE NOT (EXISTS (SELECT 1 FROM audit_log WHERE action = 'seed.synthetic'));
