/**
 * tests/integration/db.mjs -- M1: the Postgres container, the two roles, the runner.
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
