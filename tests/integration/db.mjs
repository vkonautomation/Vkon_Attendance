/**
 * tests/integration/db.mjs -- M1: the Postgres container, the two roles, the runner.
 *                          -- M2: the typed schema, the append-only audit log, the seed.
 *
 * The three claims the plan makes for this milestone, each turned into something that
 * fails when it is untrue:
 *
 *   1. `db:setup` twice is a no-op the second time. Checked as a before/after
 *      fingerprint of the catalog rather than "it did not throw", because a script can
 *      run twice, succeed twice, and still leave privileges different from the ones it
 *      started with.
 *   2. A failing migration rolls back and leaves the schema at the previous version.
 *      Checked in a throwaway database, with the object the broken file created
 *      asserted absent and the ledger row asserted unwritten.
 *   3. Nothing is reachable except from the container network. Checked against the
 *      production compose file (no published ports at all) and by actually connecting
 *      from a second container on `attendance-internal`.
 *
 * Plus the property the two-role split exists to provide, which is cheap to prove: the
 * application role can write rows and cannot create objects.
 *
 * M2 adds the schema assertions the plan names, and one rule about how they are
 * written: a rejection only counts when the database says why. "INSERT failed" is not
 * evidence that a CHECK constraint works -- a typo in a column name, a missing FK
 * target or a permission problem all fail an insert too, and a suite that accepts any
 * of those as a pass is a suite that stays green while the constraint it tests is
 * deleted. Every check below matches the message, and the ones that matter also run
 * the same statement in its legal form first, so "the table is not writable at all"
 * cannot be mistaken for "the constraint works".
 *
 * Skip behaviour is deliberate and loud. Without a reachable database most of this
 * cannot run, so it prints SKIPPED and exits 0 unless REQUIRE_DB=1, in which case a
 * missing database is a failure. The alternative -- failing quietly -- is how a suite
 * ends up green on a machine that tested nothing.
 *
 * Usage: node tests/integration/db.mjs        (or: npm run test:db)
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { loadEnvChain } from "../../scripts/lib/env.mjs";

const ROOT = resolve(join(fileURLToPath(new URL(".", import.meta.url)), "..", ".."));
const FIXTURES = join(ROOT, "tests", "fixtures", "migrations");
const REQUIRE_DB = process.env.REQUIRE_DB === "1";

const checks = [];
let skipped = null;

function check(name, passed, detail) {
  checks.push({ name, passed: !!passed, detail });
  console.log(`${passed ? "ok    " : "FAIL  "} ${name}`);
  if (!passed && detail) console.log(`        ${String(detail).split("\n").slice(0, 4).join("\n        ")}`);
}

async function connect(url, label) {
  const client = new Client({ connectionString: url, application_name: `vkon-attendance-${label}` });
  await client.connect();
  return client;
}

/* ------------------------------------------------------------------ docker helpers */

function docker(args, opts) {
  return spawnSync("docker", args, { cwd: ROOT, encoding: "utf8", ...opts });
}

function dockerAvailable() {
  const r = docker(["info", "--format", "{{.ServerVersion}}"]);
  return r.status === 0;
}

/* ------------------------------------------------------------------------ catalogue */

// Everything below has to be compared as text: a fingerprint that is a JS object has
// to be deep-compared, and a deep comparison that normalises the things that actually
// matter (grant order, role attributes) is how a real change slips through.
//
// Every column is cast to text explicitly. pg_roles exposes its booleans as the
// historical "char" type rather than boolean, and `text || "char"` is ambiguous in
// the parser -- it errors instead of guessing, which is the right call by Postgres
// and a confusing one to debug at 1am without the cast.
const ROLE_FINGERPRINT = `
  SELECT rolname || '|login=' || rolcanlogin::text || '|super=' || rolsuper::text ||
         '|createrole=' || rolcreaterole::text || '|createdb=' || rolcreatedb::text ||
         '|inherit=' || rolinherit::text || '|replication=' || rolreplication::text ||
         '|connlimit=' || rolconnlimit::text || '|bypassrls=' || rolbypassrls::text AS line
    FROM pg_roles ORDER BY line`;

const TABLE_ACL_FINGERPRINT = `
  SELECT c.relname || ' :: ' || coalesce(array_to_string(c.relacl, ','), '(owner only)') AS line
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relkind IN ('r', 'S') ORDER BY line`;

const DEFAULT_ACL_FINGERPRINT = `
  SELECT pg_get_userbyid(defaclrole) || ' :: ' || defaclobjtype::text || ' :: '
         || coalesce(array_to_string(defaclacl, ','), '(none)') AS line
    FROM pg_default_acl ORDER BY line`;

const SCHEMA_ACL_FINGERPRINT = `
  SELECT nspname || ' :: ' || coalesce(array_to_string(nspacl, ','), '(owner only)') AS line
    FROM pg_namespace ORDER BY line`;

async function fingerprint(client) {
  const parts = [];
  for (const sql of [ROLE_FINGERPRINT, TABLE_ACL_FINGERPRINT, DEFAULT_ACL_FINGERPRINT, SCHEMA_ACL_FINGERPRINT]) {
    const rows = (await client.query(sql)).rows.map((r) => r.line);
    parts.push(rows.join("\n"));
  }
  return parts.join("\n---\n");
}

/* ----------------------------------------------------------------- migrate runner */

function runMigrate(dir, extraEnv) {
  const r = spawnSync(process.execPath, [join(ROOT, "scripts", "db-migrate.mjs"), "--dir", dir], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, ...extraEnv },
  });
  return { code: r.status, out: `${r.stdout || ""}${r.stderr || ""}` };
}

function runSetup(extraEnv) {
  const r = spawnSync(process.execPath, [join(ROOT, "scripts", "db-setup.mjs")], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, ...extraEnv },
  });
  return { code: r.status, out: `${r.stdout || ""}${r.stderr || ""}` };
}

function sha256(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/* ---------------------------------------------------------------------- the suite */

async function main() {
  loadEnvChain();
  const ownerUrl = process.env.DATABASE_URL_OWNER || process.env.DATABASE_URL;
  const appUrl = process.env.DATABASE_URL_APP;

  if (!ownerUrl) {
    skipped = "DATABASE_URL_OWNER is unset";
    return;
  }

  let owner;
  try {
    owner = await connect(ownerUrl, "test-owner");
  } catch (e) {
    skipped = `cannot reach the database at ${ownerUrl.replace(/:[^:@/]*@/, ":***@")}: ${e.message}`;
    return;
  }

  try {
    await ledgerChecks(owner);
    await setupIsIdempotent(owner);
    if (appUrl) await roleSeparation(appUrl);
    else check("DATABASE_URL_APP set (role separation tests)", false, "skipped group: set DATABASE_URL_APP");
    await migrationRollback(owner);
    if (appUrl) await schemaConstraints(appUrl, owner);
    else check("DATABASE_URL_APP set (schema constraint tests)", false, "skipped group: set DATABASE_URL_APP");
    await seedIsIdempotent(owner);
    await referenceDataChecks(owner);
    await portExposure();
  } finally {
    await owner.end();
  }
}

/* ------------------------------------------------- the migrations already on this box */

async function ledgerChecks(owner) {
  const dir = join(ROOT, "db", "migrations");
  const rows = (await owner.query(
    "SELECT name, checksum FROM schema_migrations ORDER BY name",
  )).rows;

  check("schema_migrations exists and is the runner's shape",
    rows.length > 0, `no rows: run npm run db:migrate (${rows.length} rows)`);

  for (const row of rows) {
    let file;
    try {
      file = readFileSync(join(dir, row.name), "utf8");
    } catch (e) {
      check(`${row.name} is still in the repository`, false, e.message);
      continue;
    }
    check(`${row.name} on disk matches the checksum the runner recorded`,
      sha256(file) === row.checksum,
      "someone edited a migration that already ran -- write a new one instead");
  }

  // 0001_extensions.sql installed pgcrypto for digest(); if the extension did not
  // actually apply, "the migration ran" and "the schema works" are different facts.
  const ext = (await owner.query(
    "SELECT 1 FROM pg_extension WHERE extname = 'pgcrypto'",
  )).rowCount === 1;
  check("pgcrypto is installed", ext);

  const digest = await owner.query("SELECT encode(digest('vkon', 'sha256'), 'hex') AS h");
  check("digest() agrees with node:crypto",
    digest.rows[0].h === sha256("vkon"), digest.rows[0].h);

  const reRun = runMigrate(dir);
  check("db:migrate again is a no-op",
    reRun.code === 0 && /nothing pending/.test(reRun.out), reRun.out);
}

/* --------------------------------------------------------- claim 1: setup is a no-op */

async function setupIsIdempotent(owner) {
  const before = await fingerprint(owner);
  const first = runSetup();
  const middle = await fingerprint(owner);
  const second = runSetup();
  const after = await fingerprint(owner);

  check("db:setup runs successfully (1st and 2nd invocation)",
    first.code === 0 && second.code === 0, `${first.out}\n${second.out}`);
  check("db:setup twice changes nothing in the catalog",
    middle === after,
    `differs:\n${describeDiff(middle, after)}`);
  check("db:setup is idempotent from a clean start too",
    before === after,
    `differs:\n${describeDiff(before, after)}`);
}

function describeDiff(a, b) {
  const left = a.split("\n");
  const right = b.split("\n");
  const out = [];
  for (const line of left) if (!right.includes(line)) out.push(`- ${line}`);
  for (const line of right) if (!left.includes(line)) out.push(`+ ${line}`);
  return out.slice(0, 10).join("\n") || "(same lines, different order)";
}

/* -------------------------------------------- the two-role split, as the API will use it */

async function roleSeparation(url) {
  let app;
  try {
    app = await connect(url, "test-app");
  } catch (e) {
    check("attendance_app can connect", false, e.message);
    return;
  }
  try {
    check("attendance_app can connect", true);
    // pg_roles exposes its booleans as the legacy "char" type, whose text form is
    // "true"/"false" rather than the "t"/"f" a boolean cast produces -- so this
    // accepts either rather than asserting a rendering detail nobody remembers.
    const sup = (await app.query(
      "SELECT rolsuper::text AS s FROM pg_roles WHERE rolname = current_user",
    )).rows[0].s;
    check("attendance_app is not a superuser", sup === "false" || sup === "f", sup);

    const read = await app.query("SELECT COUNT(*)::int AS n FROM schema_migrations");
    check("attendance_app can SELECT the tables the owner created", read.rows[0].n >= 0);

    // The reason for the split, stated once as an assertion instead of once as a
    // comment: an injection in a route handler runs as this role, so it can reach rows
    // but it cannot install a trigger, a function or a table that rewrites history.
    await assertFails(app, "CREATE TABLE attendance_app_should_not_make_one (x int)",
      "attendance_app cannot CREATE TABLE");
    await assertFails(app, "CREATE FUNCTION vkon_not_a_function() RETURNS int AS $$ SELECT 1 $$ LANGUAGE sql",
      "attendance_app cannot CREATE FUNCTION");
    // The plan's threat, stated literally: an SQL injection in a route handler must not
    // be able to install something that rewrites attendance history, and a trigger is
    // exactly that. Creating one needs ownership of the table, which this role does not
    // have -- the same fact that makes UPDATE audit_log impossible is enforced twice.
    await assertFails(app,
      "CREATE TRIGGER vkon_bad_trig BEFORE INSERT ON schema_migrations EXECUTE PROCEDURE vkon_not_a_function()",
      "attendance_app cannot CREATE TRIGGER on a table it does not own");
    await assertFails(app, "DROP TABLE schema_migrations",
      "attendance_app cannot DROP the runner's ledger");
  } finally {
    await app.end();
  }
}

async function assertFails(client, sql, name) {
  try {
    await client.query(`BEGIN; ${sql}; ROLLBACK`);
    check(name, false, "the statement succeeded");
  } catch (e) {
    check(name, true);
    if (/^\s*BEGIN/.test(e.message)) check(name + " (no harness error)", false, e.message);
  }
}

/* ------------------------------------------------- claim 2: a bad migration rolls back */

async function migrationRollback(owner) {
  const dbname = `vkon_m1_${process.pid}`;
  await owner.query(`CREATE DATABASE ${dbname}`);

  const url = new URL(process.env.DATABASE_URL_OWNER || process.env.DATABASE_URL);
  url.pathname = `/${dbname}`;
  const scratch = String(url);

  let client;
  try {
    client = await connect(scratch, "test-scratch");
    const good = join(FIXTURES, "good");
    const bad = join(FIXTURES, "bad");
    const env = { DATABASE_URL_OWNER: scratch };

    const applied = runMigrate(good, env);
    check("fixture: the good set applies",
      applied.code === 0 && /2 migration\(s\) applied/.test(applied.out), applied.out);

    const again = runMigrate(good, env);
    check("fixture: re-running the good set is a no-op",
      again.code === 0 && /nothing pending/.test(again.out), again.out);

    const failed = runMigrate(bad, env);
    check("fixture: the bad set fails and is reported as rolled back",
      failed.code !== 0 && /0002_broken\.sql failed and was rolled back/.test(failed.out),
      `exit ${failed.code}: ${failed.out}`);

    const ledger = (await client.query(
      "SELECT name FROM schema_migrations ORDER BY name",
    )).rows.map((r) => r.name);
    check("the schema is left at the previous version (ledger unchanged)",
      ledger.join(",") === "0001_alpha.sql,0002_beta.sql", ledger.join(","));

    const broken = (await client.query(
      "SELECT to_regclass('fixture_broken') AS t",
    )).rows[0].t;
    check("the object created before the failure is gone (not half-applied)",
      broken === null, String(broken));

    // The good set's own work must survive the failed run, or "rolled back" would also
    // mean "the runner wiped the database", which is a worse bug than the one it fixes.
    const beta = (await client.query("SELECT note FROM fixture_beta WHERE id = 1")).rows;
    check("earlier migrations are untouched by a later failure", beta.length === 1);

    const drift = runMigrate(join(FIXTURES, "drift"), env);
    check("editing a migration that already ran is refused, not skipped",
      drift.code !== 0 && /contents have changed/.test(drift.out), `exit ${drift.code}: ${drift.out}`);
  } finally {
    if (client) await client.end().catch(() => {});
    await owner.query(`DROP DATABASE IF EXISTS ${dbname}`).catch(() => {});
  }
}

/* ------------------------------------------------ M2: the typed schema, constraint by constraint */

// A probe row that satisfies every constraint except the one under test. It is created
// inside the same transaction as the statement expected to fail and the transaction is
// always rolled back, so the suite leaves no rows behind and needs no cleanup step that
// could itself fail and mask the result.
const PROBE_EMPLOYEE = `
  INSERT INTO employees (employee_code, username, name, role, monthly_salary, active)
  VALUES ('ZZPROBE', 'zzprobe', 'A Probe Person', 'employee', 40000.00, true)
  RETURNING id`;

// Leaves point at leave_kinds, so the probe needs a kind of its own. Relying on the
// seeded codes would make every constraint below depend on the seed having run first,
// which is a different test in disguise -- and an FK failure looks exactly like a
// constraint working when the message is not read.
const PROBE_LEAVE_KIND = `
  INSERT INTO leave_kinds (code, name, browser_category, paid, counts_as_lop)
  VALUES ('zz_probe', 'A Probe Kind', 'Probe Leave', true, false)`;

/**
 * `because` is the part of the server's message that identifies which rule fired. A
 * regex or a substring; anything else counts as a failure with the real message shown,
 * so a constraint removed from a migration cannot pass as a passing test.
 */
async function expectRejection(client, name, because, build) {
  await client.query("BEGIN");
  try {
    await client.query(PROBE_LEAVE_KIND);
    const id = (await client.query(PROBE_EMPLOYEE)).rows[0].id;
    try {
      await build(client, id);
      check(name, false, "the statement was accepted");
    } catch (e) {
      const msg = String(e.message || "");
      const ok = because instanceof RegExp ? because.test(msg) : msg.includes(because);
      check(name, ok, ok ? undefined : `rejected for a different reason: ${msg.split("\n")[0]}`);
    }
  } finally {
    await client.query("ROLLBACK").catch(() => {});
  }
}

async function expectAcceptance(client, name, build) {
  await client.query("BEGIN");
  try {
    await client.query(PROBE_LEAVE_KIND);
    const id = (await client.query(PROBE_EMPLOYEE)).rows[0].id;
    await build(client, id);
    check(name, true);
  } catch (e) {
    check(name, false, String(e.message).split("\n")[0]);
  } finally {
    await client.query("ROLLBACK").catch(() => {});
  }
}

async function schemaConstraints(appUrl, owner) {
  const app = await connect(appUrl, "test-schema");
  try {
    /* ---------------------------------------------- the four the plan names explicitly */

    await expectRejection(app, "a negative monthly_salary is rejected (D5 payroll)",
      /monthly_salary_check/, (c, id) =>
        c.query(`UPDATE employees SET monthly_salary = -1 WHERE id = $1`, [id]));

    // The legal form first: without this, "the update failed" could mean the column is
    // not writable at all rather than that the constraint works.
    await expectAcceptance(app, "a zero monthly_salary is accepted (so the check above is the check)",
      (c, id) => c.query(`UPDATE employees SET monthly_salary = 0 WHERE id = $1`, [id]));

    // The second row differs in username, so only one rule can be the reason it fails:
    // as written both columns are unique, and a duplicate-key message naming the
    // username index would pass this test for the wrong constraint.
    await expectRejection(app, "a duplicate employee_code is rejected",
      /employees_employee_code_key/,
      (c) => c.query(PROBE_EMPLOYEE.replace("'zzprobe'", "'zzprobe9'")));

    // half_day is absent by policy (D5), not by oversight. Asserting the column is gone
    // is the only way to notice it came back: a schema that grows it again reopens a
    // payroll decision that has already been made, and no other test would say so.
    const halfDay = await app.query(`
      SELECT table_name, column_name FROM information_schema.columns
       WHERE column_name IN ('half_day', 'halfday', 'is_half_day')`);
    check("no half_day column exists anywhere in the schema (D5: whole-day LOP only)",
      halfDay.rowCount === 0,
      halfDay.rows.map((r) => `${r.table_name}.${r.column_name}`).join(", "));

    // Write one entry first, then try to edit and to erase it. Both must be refused, and
    // the insert must succeed, or the refusals prove nothing.
    await expectAcceptance(app, "audit_log accepts an INSERT (control for the checks below)",
      (c, id) => c.query(
        `INSERT INTO audit_log (actor_employee_id, action, entity_type, detail)
         VALUES ($1, 'test.insert', 'employees', '{"why":"suite control"}')`, [id]));

    // The two layers say different things, and testing them as one message would hide
    // which one is doing the work. As attendance_app the privilege check answers first,
    // so the server refuses before the trigger is reached -- that is layer one working,
    // not the trigger failing. As the owner, grants cannot refuse anything, because a
    // table owner holds every privilege by ownership: only the trigger can produce a
    // refusal there, so "append-only" is the only acceptable message.
    const refusals = [
      ["UPDATE", "UPDATE audit_log SET action = 'test.rewritten' WHERE action = 'test.insert'"],
      ["DELETE", "DELETE FROM audit_log WHERE action = 'test.insert'"],
      // A TRUNCATE fires no row-level trigger at all, which is why 0005 gives it a
      // statement-level one. Without that second function this is the one verb that
      // would empty a year of attendance evidence while every other check stayed green.
      ["TRUNCATE", "TRUNCATE audit_log"],
    ];
    for (const [verb, sql] of refusals) {
      await expectRejection(app, `layer one: audit_log refuses ${verb} as attendance_app`,
        /permission denied/, (c) => writeThen(c, sql));
      await expectRejection(owner, `layer two: audit_log refuses ${verb} as the owner, by trigger`,
        /append-only/, (c) => writeThen(c, sql));
    }

    const privs = (await app.query(`
      SELECT has_table_privilege(current_user, 'audit_log', 'UPDATE')  AS upd,
             has_table_privilege(current_user, 'audit_log', 'DELETE')  AS del,
             has_table_privilege(current_user, 'audit_log', 'TRUNCATE') AS trunc,
             has_table_privilege(current_user, 'audit_log', 'INSERT')  AS ins`)).rows[0];
    check("layer one: attendance_app holds no UPDATE/DELETE/TRUNCATE on audit_log",
      privs.upd === false && privs.del === false && privs.trunc === false,
      JSON.stringify(privs));
    check("layer one: attendance_app still holds INSERT on audit_log",
      privs.ins === true, JSON.stringify(privs));

    /* ------------------------------------------------ the rules the projection depends on */

    // One row per employee per attendance day is what makes the offline queue safe to
    // flush twice (M6), and punch_id is the key that makes it safe across a day change.
    await expectRejection(app, "a second row for the same employee and attendance_day is refused",
      /records_employee_id_attendance_day_key|duplicate key/,
      async (c, id) => {
        await c.query(`INSERT INTO records (employee_id, attendance_day, check_in_at) VALUES ($1, DATE '2026-01-05', TIMESTAMPTZ '2026-01-05 09:00:00+05:30')`, [id]);
        await c.query(`INSERT INTO records (employee_id, attendance_day, check_in_at) VALUES ($1, DATE '2026-01-05', TIMESTAMPTZ '2026-01-05 09:30:00+05:30')`, [id]);
      });

    await expectRejection(app, "a replayed punch_id is refused (the idempotency key)",
      /records_punch_id_key|duplicate key/,
      async (c, id) => {
        const punch = await genUuid(c);
        await c.query(`INSERT INTO records (employee_id, attendance_day, check_in_at, punch_id) VALUES ($1, DATE '2026-01-06', TIMESTAMPTZ '2026-01-06 09:00:00+05:30', $2)`, [id, punch]);
        await c.query(`INSERT INTO records (employee_id, attendance_day, check_in_at, punch_id) VALUES ($1, DATE '2026-01-07', TIMESTAMPTZ '2026-01-07 09:00:00+05:30', $2)`, [id, punch]);
      });

    await expectRejection(app, "a punch cannot check out before it checked in",
      /check constraint/,
      (c, id) => c.query(`INSERT INTO records (employee_id, attendance_day, check_in_at, check_out_at)
        VALUES ($1, DATE '2026-01-08', TIMESTAMPTZ '2026-01-08 18:00:00+05:30', TIMESTAMPTZ '2026-01-08 09:00:00+05:30')`, [id]));

    await expectRejection(app, "source 'punch' requires a check-in time",
      /check constraint/,
      (c, id) => c.query(`INSERT INTO records (employee_id, attendance_day, source) VALUES ($1, DATE '2026-01-09', 'punch')`, [id]));

    await expectRejection(app, "an out-of-range latitude is refused rather than rounded",
      /check constraint/,
      (c, id) => c.query(`INSERT INTO records (employee_id, attendance_day, check_in_at, check_in_lat)
        VALUES ($1, DATE '2026-01-10', TIMESTAMPTZ '2026-01-10 09:00:00+05:30', 91.5)`, [id]));

    await expectRejection(app, "a second approved WFH for the same work day is refused",
      /wfh_employee_id_work_day_key|duplicate key/,
      async (c, id) => {
        const ins = `INSERT INTO wfh (employee_id, work_day, reason, state, decided_by, decided_at)
          VALUES ($1, DATE '2026-02-02', 'client site', 'Approved', $1, now())`;
        await c.query(ins, [id]);
        await c.query(ins, [id]);
      });

    /* ------------------------------------------------------- the payroll and approval rules */

    await expectRejection(app, "lop_days cannot be 0.5 or 2 (D5 stores whole days only)",
      /lop_days_check|check constraint/,
      (c, id) => c.query(`INSERT INTO lop_entries (employee_id, lop_date, lop_days, source) VALUES ($1, DATE '2026-03-03', 2, 'leave')`, [id]));

    await expectRejection(app, "a duplicate active LOP entry is refused, as the browser's guard refuses it",
      /lop_entries_active_key|duplicate key/,
      async (c, id) => {
        await c.query(`INSERT INTO lop_entries (employee_id, lop_date, source) VALUES ($1, DATE '2026-03-04', 'short-hours')`, [id]);
        await c.query(`INSERT INTO lop_entries (employee_id, lop_date, source) VALUES ($1, DATE '2026-03-04', 'short-hours')`, [id]);
      });

    await expectRejection(app, "a leave that ends before it starts is refused",
      /leaves_to_date_check|check constraint/,
      (c, id) => c.query(`INSERT INTO leaves (employee_id, kind_code, from_date, to_date, reason)
        VALUES ($1, 'zz_probe', DATE '2026-03-10', DATE '2026-03-08', 'backdated')`, [id]));

    await expectRejection(app, "an Approved leave with nobody recorded as deciding it is refused",
      /check constraint/,
      (c, id) => c.query(`INSERT INTO leaves (employee_id, kind_code, from_date, to_date, reason, state)
        VALUES ($1, 'zz_probe', DATE '2026-03-11', DATE '2026-03-11', 'untraceable', 'Approved')`, [id]));

    await expectRejection(app, "a state outside the portal's vocabulary is refused by the domain",
      /request_state|check constraint/,
      (c, id) => c.query(`INSERT INTO leaves (employee_id, kind_code, from_date, to_date, reason, state)
        VALUES ($1, 'zz_probe', DATE '2026-03-12', DATE '2026-03-12', 'x', 'Almost Approved')`, [id]));

    await expectRejection(app, "the same request cannot be approved twice at one step",
      /approvals_entity_type_entity_id_step_key|duplicate key/,
      async (c, id) => {
        const target = (await c.query(`INSERT INTO leaves (employee_id, kind_code, from_date, to_date, reason)
          VALUES ($1, 'zz_probe', DATE '2026-03-13', DATE '2026-03-13', 'dup step') RETURNING id`, [id])).rows[0].id;
        const step = `INSERT INTO approvals (entity_type, entity_id, step, approver_id, state, decided_at)
          VALUES ('leave', $1, 1, $2, 'Approved', now())`;
        await c.query(step, [target, id]);
        await c.query(step, [target, id]);
      });

    await expectRejection(app, "a third approval step is refused: manager_then_admin is two",
      /approvals_step_check|check constraint/,
      (c, id) => c.query(`INSERT INTO approvals (entity_type, entity_id, step, approver_id, state)
        VALUES ('lop', $1, 3, $2, 'Pending Admin')`, [id, id]));

    await expectRejection(app, "a 'missing check-in' claim with no check-in time is refused",
      /check constraint/,
      (c, id) => c.query(`INSERT INTO regularisations (employee_id, target_date, kind, reason)
        VALUES ($1, DATE '2026-04-01', 'missing_check_in', 'forgot to punch')`, [id]));

    // The partial index: a rejected claim is history, not a lock. Asserting the legal
    // case is what stops the check above from passing because the table rejects
    // everything for this employee.
    await expectAcceptance(app, "re-applying a regularisation after a rejection is allowed",
      async (c, id) => {
        await c.query(`INSERT INTO regularisations
            (employee_id, target_date, kind, actual_in, reason, state, decided_by, decided_at)
            VALUES ($1, DATE '2026-04-02', 'missing_check_in', TIME '09:15:00',
                    'bus was late', 'Rejected', $1, now())`, [id]);
        await c.query(`INSERT INTO regularisations
            (employee_id, target_date, kind, actual_in, reason)
            VALUES ($1, DATE '2026-04-02', 'missing_check_in', TIME '09:15:00',
                    'same day, second attempt')`, [id]);
      });

    await expectRejection(app, "a second open regularisation for one day is refused",
      /regularisations_open_one|duplicate key/,
      async (c, id) => {
        const open = `INSERT INTO regularisations (employee_id, target_date, kind, actual_in, reason)
          VALUES ($1, DATE '2026-04-03', 'missing_check_in', TIME '09:15:00', 'duplicate claim')`;
        await c.query(open, [id]);
        await c.query(open, [id]);
      });

    await expectRejection(app, "a notification that names an entity but not its id is refused",
      /check constraint/,
      (c, id) => c.query(`INSERT INTO notifications (employee_id, kind, title, body, entity_type)
        VALUES ($1, 'alert', 't', 'b', 'leave')`, [id]));

    await expectRejection(app, "a session token that is not sha256 hex is refused",
      /token_hash_check|check constraint/,
      (c, id) => c.query(`INSERT INTO sessions (employee_id, token_hash, expires_at)
        VALUES ($1, 'not-a-hash', now() + interval '1 hour')`, [id]));

    await expectRejection(app, "an employee cannot be their own manager",
      /check constraint|violates/,
      (c, id) => c.query(`UPDATE employees SET manager_id = id WHERE id = $1`, [id]));

    await expectRejection(app, "a lower-case employee_code is refused (the portal reads one form)",
      /employee_code_check|check constraint/,
      (c) => c.query(`INSERT INTO employees (employee_code, username, name)
        VALUES ('zzprobe6', 'zzprobe6', 'A Probe Person')`));

    await expectRejection(app, "an unknown role is refused",
      /role_check|check constraint/,
      (c) => c.query(`INSERT INTO employees (employee_code, username, name, role)
        VALUES ('zzprobe7', 'zzprobe7', 'A Probe Person', 'superuser')`));

    await expectRejection(app, "an invalid email is refused rather than stored and mailed later",
      /check constraint/,
      (c) => c.query(`INSERT INTO employees (employee_code, username, name, email)
        VALUES ('zzprobe8', 'zzprobe8', 'A Probe Person', 'not-an-email')`));

    await expectRejection(app, "a holiday kind outside declared/restricted is refused",
      /kind_check|check constraint/,
      (c) => c.query(`INSERT INTO holidays (code, holiday_date, name, kind)
        VALUES ('HOL-90', DATE '2026-08-15', 'A Test Holiday', 'optional')`));

    /* --------------------------------------------- routing, which a migration installs */

    const flow = (await app.query("SELECT entity_type, route, steps FROM approval_flow ORDER BY entity_type")).rows;
    check("approval_flow has a route for all four request types", flow.length === 4, JSON.stringify(flow));
    check("a LOP request routes manager then admin, and says so in two steps",
      flow.some((f) => f.entity_type === "lop" && f.route === "manager_then_admin" && Number(f.steps) === 2),
      JSON.stringify(flow));
  } finally {
    await app.end();
  }
}

/* ------------------------------------- the reference rows the seed is expected to leave */

// Kept separate from the constraint group because these describe seeded data, not the
// schema: run on a database that has not been seeded they would fail for a reason that
// has nothing to do with what they claim to check.
async function referenceDataChecks(owner) {
  const kinds = (await owner.query(
    "SELECT code, browser_category, quota_key, paid, counts_as_lop FROM leave_kinds ORDER BY code")).rows;
  check("every leave kind carries the browser category the projection reads",
    kinds.length > 0 && kinds.every((k) => k.browser_category),
    JSON.stringify(kinds.filter((k) => !k.browser_category)));

  // The portal's quota document has exactly two fields -- DEFAULT_GLOBAL_LEAVE_QUOTAS
  // is { personalLeave, restrictedLeave } -- so exactly two kinds may point at one. A
  // third would be a quota the front end has nowhere to display, and a missing one
  // would be a quota the projection cannot fill.
  const quotaKeys = kinds.map((k) => k.quota_key).filter(Boolean).sort().join(",");
  check("the kinds cover exactly the two quota keys the portal's quota document has",
    quotaKeys === "personalLeave,restrictedLeave", quotaKeys || "(none)");

  // The one kind that produces payroll damage, stated as data rather than as a branch:
  // unpaid and counted, or the LOP ledger would have to be inferred from a name.
  const counting = kinds.filter((k) => k.counts_as_lop);
  check("Loss of Pay is the only kind that counts as LOP, and it is unpaid",
    counting.length === 1 && counting[0].code === "loss_of_pay" && counting[0].paid === false,
    JSON.stringify(counting));

  const rh = (await owner.query("SELECT kind, COUNT(*)::int AS n FROM holidays GROUP BY kind")).rows;
  check("holidays keep the declared/restricted distinction the front end already draws",
    rh.some((r) => r.kind === "declared") && rh.some((r) => r.kind === "restricted"),
    JSON.stringify(rh));

  // getDeclaredHolidays() excludes Restricted Holidays on purpose, because a restricted
  // holiday that is not worked does not suppress a LOP day. Two rows sharing one date
  // would make that exclusion depend on which row the query happened to reach first.
  const clash = (await owner.query(`
    SELECT holiday_date, COUNT(*)::int AS n FROM holidays
     GROUP BY holiday_date HAVING COUNT(DISTINCT kind) > 1`)).rows;
  check("no date is both a declared and a restricted holiday",
    clash.length === 0, clash.map((r) => `${r.holiday_date} (${r.n})`).join(", "));
}

/** Insert a marker audit row, then attempt the forbidden verb, in one transaction. */
async function writeThen(client, sql) {
  await client.query(
    `INSERT INTO audit_log (action, entity_type, detail) VALUES ('test.insert', 'suite', '{"why":"control"}')`);
  await client.query(sql);
}

/** A uuid to reuse across two statements in one probe transaction. */
async function genUuid(client) {
  return (await client.query("SELECT gen_random_uuid() AS u")).rows[0].u;
}

/* ------------------------------------------------------------ claim 1 for the seed */

function seedResult(env) {
  const r = spawnSync(process.execPath, [join(ROOT, "scripts", "db-seed.mjs")], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  return { code: r.status, out: `${r.stdout || ""}${r.stderr || ""}` };
}

async function seedIsIdempotent(owner) {
  const first = seedResult({ VKON_ENV: "development" });
  if (first.code !== 0) {
    check("db:seed runs", false, first.out.split("\n").slice(-3).join(" | "));
    return;
  }
  check("db:seed runs", true);

  // The refusal is the more important half of that script, so test it rather than trust
  // the branch: the same file against a database told it is production must fail. An
  // explicit process.env wins over .env.local inside loadEnvChain, which is what makes
  // this a real test of the switch rather than a test of whichever file happens to set
  // the variable last.
  const prod = seedResult({ VKON_ENV: "production" });
  check("db:seed refuses when VKON_ENV=production",
    prod.code !== 0 && /refusing to seed/.test(prod.out),
    `exit ${prod.code}: ${prod.out.split("\n").filter(Boolean)[0] || "(no output)"}`);

  const second = seedResult({ VKON_ENV: "development" });
  const lines = first.out.trim().split("\n");
  const secondLines = second.out.trim().split("\n");
  const summary = (s) => (s.find((l) => l.includes("[seed]")) || "").replace(/^\[seed\] .*?: /, "");
  check("db:seed twice reports identical counts (idempotent)",
    second.code === 0 && summary(lines) === summary(secondLines),
    `1st: ${summary(lines)}\n2nd: ${summary(secondLines)}`);

  // "Identical counts" is only meaningful if the counts are not zero, and only meaningful
  // as a claim about rows if nothing else in the database is also counted. The roster and
  // the reference tables are the seed's own work, so assert those specifically.
  const counts = (await owner.query(`
    SELECT (SELECT COUNT(*) FROM employees)        AS employees,
           (SELECT COUNT(*) FROM leave_kinds)      AS kinds,
           (SELECT COUNT(*) FROM settings)         AS settings,
           (SELECT COUNT(*) FROM holidays)         AS holidays,
           (SELECT COUNT(*) FROM records)          AS records,
           (SELECT COUNT(*) FROM audit_log WHERE action = 'seed.synthetic') AS seeded`)).rows[0];
  check("the seed produced a roster and reference data, not an empty pass",
    Number(counts.employees) >= 5 && Number(counts.kinds) >= 5 && Number(counts.settings) >= 5 &&
    Number(counts.holidays) >= 2 && Number(counts.records) >= 5 && Number(counts.seeded) === 1,
    JSON.stringify(counts));

  // The plan's rule for a public repository, restated as a database assertion: a seed
  // that carries a credential is a leaked credential, however synthetic the name is.
  const hashed = (await owner.query(
    "SELECT COUNT(*) AS n FROM employees WHERE password_hash IS NOT NULL")).rows[0].n;
  check("no seeded employee has a password hash", Number(hashed) === 0, `${hashed} rows`);

  const domains = (await owner.query(`
    SELECT DISTINCT split_part(email, '@', 2) AS d FROM employees WHERE email IS NOT NULL`)).rows;
  check("every seeded email is at a reserved test domain",
    domains.every((r) => ["example.test", "example.com", "test.invalid"].includes(r.d)),
    domains.map((r) => r.d).join(", "));

  const active = (await owner.query(
    "SELECT COUNT(*) AS n FROM employees WHERE active AND role = 'admin'")).rows[0].n;
  check("the seed does not create a live administrator", Number(active) === 0,
    "the first admin is a bootstrap decision (M3), never a seeded one");
}

/* ------------------------------------------------------ claim 3: internal-only network */

async function portExposure() {
  if (!dockerAvailable()) {
    check("docker is available (compose + psql-from-container checks)", false,
      "the docker CLI did not answer; start Docker Desktop, or run with REQUIRE_DB=1 to make this fail loudly");
    return;
  }

  const base = docker(["compose", "-f", "deploy/compose.yml", "--env-file", ".env", "config", "--format", "json"]);
  if (base.status !== 0) {
    check("deploy/compose.yml parses", false, base.stderr || base.stdout);
    return;
  }
  check("deploy/compose.yml parses", true);

  let parsed;
  try {
    parsed = JSON.parse(base.stdout);
  } catch (e) {
    check("compose config is readable JSON", false, e.message);
    return;
  }
  const db = parsed.services?.db ?? parsed.Services?.db;
  check("the production service name is attendance-postgres",
    db?.container_name === "attendance-postgres", String(db?.container_name));
  check("production publishes no port at all",
    db?.ports === undefined || Object.keys(db.ports ?? {}).length === 0,
    JSON.stringify(db?.ports));
  check("production is on its own network",
    Object.keys(db?.networks ?? {}).join(",") === "attendance-internal",
    JSON.stringify(db?.networks));

  // The dev overlay is what actually runs here, so also prove that the only listener
  // is loopback: a published port bound to 0.0.0.0 would put a database on whatever
  // interface the tunnel host has, which is the exposure this whole layout prevents.
  const inspect = docker(["inspect", "attendance-postgres"]);
  if (inspect.status !== 0) {
    check("attendance-postgres is running (dev overlay)", false, inspect.stderr);
    return;
  }
  const info = JSON.parse(inspect.stdout)[0];
  const bindings = info.NetworkSettings?.Ports ?? {};
  const offenders = Object.entries(bindings).flatMap(([port, list]) =>
    (list ?? []).filter((b) => b.HostIp !== "127.0.0.1" && b.HostIp !== "::1")
      .map((b) => `${b.HostIp}:${b.HostPort} for ${port}`));
  check("every published listener on the running container is loopback-only",
    offenders.length === 0, offenders.join("; "));

  const exposed5432 = Object.keys(bindings).some((p) => p.startsWith("5432/") &&
    (bindings[p] ?? []).some((b) => b.HostPort === "5432"));
  check("the default Postgres port is not published", !exposed5432);

  // "Internal only" is a claim about reachability, so reach it: a second container on
  // the same network must get a real session, as must nothing outside it.
  const psql = await reachFromContainer();
  check("psql connects from a container on attendance-internal", psql.ok, psql.detail);
}

async function reachFromContainer() {
  const url = new URL(process.env.DATABASE_URL_OWNER);
  const args = [
    "run", "--rm", "--network", "attendance-internal",
    "-e", `PGPASSWORD=${decodeURIComponent(url.password)}`,
    "postgres:16-alpine",
    "psql", "-h", "attendance-postgres", "-p", "5432",
    "-U", decodeURIComponent(url.username), "-d", url.pathname.slice(1),
    "-At", "-c", "SELECT current_user || '@' || current_database()",
  ];
  const r = docker(args, { timeout: 120000 });
  const out = (r.stdout || "").trim();
  // Never echo the command line: it carries the password.
  return r.status === 0 && out.includes("@")
    ? { ok: true, detail: "" }
    : { ok: false, detail: (r.stderr || r.stdout || `exit ${r.status}`).split("\n").slice(0, 3).join(" | ") };
}

/* ------------------------------------------------------------------------ verdict */

// A crash is a failed check, not a stack trace. The suite runs inside `npm test`, where
// 40 lines of pg error text between two other suites reads as noise and hides the one
// line that says what broke.
try {
  await main();
} catch (e) {
  check(`unexpected error: ${e.message}`, false,
    (e.stack || "").split("\n").slice(0, 3).join("\n"));
}

if (skipped) {
  console.log(`\n=== tests/integration/db.mjs: SKIPPED (${skipped}) ===`);
  console.log("    bring the database up with: npm run db:up");
  if (REQUIRE_DB) process.exit(1);
  process.exit(0);
}

const failed = checks.filter((c) => !c.passed);
console.log(`\n=== tests/integration/db.mjs: ${checks.length - failed.length}/${checks.length} checks passed ===`);
if (failed.length) {
  console.log(`>>> ${failed.length} FAILED: ${failed.map((f) => f.name).join(", ")}`);
  process.exit(1);
}
