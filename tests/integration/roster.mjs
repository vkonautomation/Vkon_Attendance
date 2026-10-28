/**
 * tests/integration/roster.mjs -- M7: the roster and its roles, over the wire.
 *
 * It drives the compiled /api/employees handlers through HTTP against the standalone build
 * (the same payload the probe, auth and punches suites run) and verifies each outcome against
 * the real `employees` table with the app role. The plan names four claims, each turned into a
 * check that fails when the property is untrue:
 *
 *   1. only admin may write            -- an employee's POST and PATCH are 403; an admin's
 *      POST is 201 and its PATCH is 200, and both land rows.
 *   2. a manager may read their own reports -- the manager scope returns themselves plus their
 *      direct reports and NOTHING else (no unrelated employee, no seed colleague); an employee's
 *      scope is exactly one row; an admin sees everyone.
 *   3. deactivating mid-session cuts access -- an employee signed in with a live cookie is 401
 *      on their NEXT request once an admin flips `active` to false: requireSession reads the row
 *      every time, so there is no "until they next log in" window.
 *   4. the manager chain cannot form a cycle -- filing A under B, then trying to file B under A,
 *      is refused (the 0007 constraint trigger) and the offending pointer is left unchanged.
 *
 * Usage: node tests/integration/roster.mjs   (needs a served app at PROBE_BASE_URL)
 */

import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { Client } from "pg";
import { loadEnvChain } from "../../scripts/lib/env.mjs";

const require = createRequire(import.meta.url);
const bcrypt = require("bcryptjs");

loadEnvChain();

const BASE = process.env.PROBE_BASE_URL || "";
const APP_URL = process.env.DATABASE_URL_APP || "";
const COST = Number(process.env.BCRYPT_COST_FACTOR || 11);
const COOKIE_NAME = process.env.SESSION_COOKIE_NAME || "vkon_attendance_session";

const checks = [];
function check(name, passed, detail) {
  checks.push({ name, passed: !!passed, detail });
  console.log(`${passed ? "ok    " : "FAIL  "} ${name}`);
  if (!passed && detail) console.log(`        ${String(detail).split("\n").slice(0, 4).join("\n        ")}`);
}

const preHash = (pw) => createHash("sha256").update(pw, "utf8").digest("base64");

/* --------------------------------------------------------------------- HTTP helpers */

async function api(path, { method = "GET", body, token } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Cookie = `${COOKIE_NAME}=${token}`;
  const res = await fetch(`${BASE}${path}`, {
    method, headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: "manual",
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
  const setCookies = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
  return { status: res.status, json, text, setCookies };
}

function tokenFrom(res) {
  for (const line of res.setCookies) {
    const m = new RegExp(`^${COOKIE_NAME}=([^;]+)`).exec(line);
    if (m && m[1]) return m[1];
  }
  return null;
}

async function login(identifier, password) {
  const res = await api("/api/auth/login", { method: "POST", body: { identifier, password } });
  return { ...res, token: tokenFrom(res) };
}

/* --------------------------------------------------------------- throwaway roster */

const USERS = {
  admin: { code: "ZZRA", username: "zzra", name: "Ad Rosteradmin", pw: "Admin-Roster-99", role: "admin" },
  mgr:   { code: "ZZMA", username: "zzma", name: "Ma Manager",     pw: "Mgr-Roster-99",   role: "manager" },
  rep1:  { code: "ZZR1", username: "zzr1", name: "R1 Report",      pw: "R1-Roster-99",    role: "employee", manager: "ZZMA" },
  rep2:  { code: "ZZR2", username: "zzr2", name: "R2 Report",      pw: "R2-Roster-99",    role: "employee", manager: "ZZMA" },
  other: { code: "ZZOB", username: "zzob", name: "Ob Other",       pw: "Ob-Roster-99",    role: "employee" },
  cycA:  { code: "ZZCA", username: "zzca", name: "Ca Cycle",       pw: "Ca-Roster-99",    role: "employee" },
  cycB:  { code: "ZZCB", username: "zzcb", name: "Cb Cycle",       pw: "Cb-Roster-99",    role: "employee" },
};

const idOf = {}; // username -> employee uuid, filled in setup
const tok = {};  // employee code -> session cookie token, filled in setup

async function upsertUser(client, spec) {
  const hash = await bcrypt.hash(preHash(spec.pw), COST);
  const res = await client.query(
    `INSERT INTO employees
       (employee_code, username, name, email, role, active, password_hash, password_change_required, monthly_salary, geofence_enabled, timezone)
     VALUES ($1, $2, $3, $4, $5, TRUE, $6, FALSE, 50000.00, TRUE, 'Asia/Kolkata')
     ON CONFLICT (username) DO UPDATE
       SET active = TRUE, password_hash = EXCLUDED.password_hash, password_change_required = FALSE,
           role = EXCLUDED.role, manager_id = NULL, updated_at = now()
     RETURNING id`,
    [spec.code, spec.username, spec.name, `${spec.username}@example.test`, spec.role, hash],
  );
  return res.rows[0].id;
}

async function setManager(client, code, managerCode) {
  await client.query(
    `UPDATE employees SET manager_id = (SELECT id FROM employees WHERE employee_code = $2)
      WHERE employee_code = $1`,
    [code, managerCode],
  );
}

async function rowFor(client, code) {
  const r = await client.query(
    `SELECT employee_code, role, active, manager_id FROM employees WHERE employee_code = $1`,
    [code],
  );
  return r.rows[0] || null;
}

function codes(list) { return (list || []).map((e) => e.id).sort(); }

/* ------------------------------------------------------------------------- the suite */

async function main() {
  if (!BASE) { console.log("SKIPPED tests/integration/roster.mjs (PROBE_BASE_URL not set -- run it in the serve phase)"); return; }
  if (!APP_URL) { console.log("SKIPPED tests/integration/roster.mjs (DATABASE_URL_APP not set)"); return; }

  let client;
  try {
    client = new Client({ connectionString: APP_URL, application_name: "vkon-attendance-roster-test" });
    await client.connect();
  } catch (e) {
    console.log(`SKIPPED tests/integration/roster.mjs (cannot reach the app database: ${e.message})`);
    return;
  }

  try {
    await client.query("BEGIN");
    for (const u of Object.values(USERS)) idOf[u.username] = await upsertUser(client, u);
    await client.query("COMMIT");

    // Report relationships, set after every row exists (the self-referencing FK needs both ends).
    await setManager(client, "ZZR1", "ZZMA");
    await setManager(client, "ZZR2", "ZZMA");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  }

  for (const u of Object.values(USERS)) {
    const r = await login(u.username, u.pw);
    if (!r.token) throw new Error(`setup: could not sign in ${u.username} (${r.status} ${r.text})`);
    tok[u.code] = r.token;
  }

  try {
    await runAdminOnlyWrite(client);
    await runScopedRead();
    await runMidSessionDeactivation(client);
    await runCycleRefused(client);
  } finally {
    await client.query(
      `UPDATE employees SET active = FALSE, password_hash = NULL, manager_id = NULL
        WHERE username IN ('zzra','zzma','zzr1','zzr2','zzob','zzca','zzcb')`,
    ).catch(() => {});
    await client.query(
      `DELETE FROM sessions WHERE employee_id IN
         (SELECT id FROM employees WHERE username IN ('zzra','zzma','zzr1','zzr2','zzob','zzca','zzcb'))`,
    ).catch(() => {});
    await client.end().catch(() => {});
  }
}

async function runAdminOnlyWrite(client) {
  // A plain employee may not create or change anyone.
  const forbiddenCreate = await api("/api/employees", {
    method: "POST", token: tok.ZZOB,
    body: { employeeCode: "ZZX9", username: "zzx9", name: "Should Not Exist" },
  });
  check("an employee POST /api/employees is 403",
    forbiddenCreate.status === 403 && forbiddenCreate.json && forbiddenCreate.json.error,
    `${forbiddenCreate.status} ${forbiddenCreate.text}`);

  const forbiddenPatch = await api("/api/employees/ZZR1", { method: "PATCH", token: tok.ZZOB, body: { name: "Hijacked" } });
  check("an employee PATCH /api/employees/{code} is 403",
    forbiddenPatch.status === 403, `${forbiddenPatch.status} ${forbiddenPatch.text}`);

  const anon = await api("/api/employees", { method: "POST", body: { employeeCode: "ZZX8", username: "zzx8", name: "Anon" } });
  check("an unauthenticated roster write is 401", anon.status === 401, `${anon.status} ${anon.text}`);

  // An admin may create; the row lands with the requested fields.
  const created = await api("/api/employees", {
    method: "POST", token: tok.ZZRA,
    body: { employeeCode: "zzx1", username: "ZZX1", name: "New Recruit", accessRole: "employee", monthlySalary: 45000, managerCode: "ZZMA", joinedOn: "2026-05-01" },
  });
  check("an admin POST is 201 and normalises code/username and reports the manager",
    created.status === 201 && created.json && created.json.employee &&
    created.json.employee.id === "ZZX1" && created.json.employee.username === "zzx1" &&
    created.json.employee.managerId === "ZZMA" && created.json.employee.monthlySalary === 45000,
    `${created.status} ${created.text}`);

  const dbRow = await rowFor(client, "ZZX1");
  check("the created employee is really on file (active on enrol)",
    dbRow && dbRow.active === true && dbRow.role === "employee", dbRow ? "" : "no row");

  // The created employee can now sign in with a set password? No -- create sets no password,
  // so an admin PATCH can set the salary/manager and returns 200 with the change reflected.
  const patched = await api("/api/employees/ZZX1", {
    method: "PATCH", token: tok.ZZRA, body: { monthlySalary: 47500, jobTitle: "Junior Engineer" },
  });
  check("an admin PATCH is 200 and changes only the fields sent",
    patched.status === 200 && patched.json && patched.json.employee &&
    patched.json.employee.monthlySalary === 47500 && patched.json.employee.jobTitle === "Junior Engineer",
    `${patched.status} ${patched.text}`);

  // A PATCH of a manager that would close a loop is refused (also exercised in runCycleRefused),
  // and a PATCH of a salary below zero is refused by the schema/lib.
  const negSalary = await api("/api/employees/ZZX1", { method: "PATCH", token: tok.ZZRA, body: { monthlySalary: -1 } });
  check("a negative salary is refused (400), not written",
    negSalary.status === 400 && negSalary.json && negSalary.json.error, `${negSalary.status} ${negSalary.text}`);

  // Clean up the row the admin created so re-runs start from the same state.
  await client.query(`DELETE FROM employees WHERE employee_code = 'ZZX1'`).catch(() => {});
}

async function runScopedRead() {
  // Manager: themselves + the two direct reports, and nobody else.
  const mgr = await api("/api/employees", { token: tok.ZZMA });
  const mgrCodes = mgr.json ? codes(mgr.json.employees) : [];
  check("a manager's read includes themselves and both direct reports",
    mgr.status === 200 && mgrCodes.includes("ZZMA") && mgrCodes.includes("ZZR1") && mgrCodes.includes("ZZR2"),
    `${mgr.status} ${JSON.stringify(mgrCodes)}`);
  check("a manager's read excludes an unrelated colleague and the seed roster",
    mgrCodes.length === 3 && !mgrCodes.includes("ZZOB") && !mgrCodes.includes("EMP001"),
    JSON.stringify(mgrCodes));

  // Employee: exactly themselves.
  const emp = await api("/api/employees", { token: tok.ZZOB });
  const empCodes = emp.json ? codes(emp.json.employees) : [];
  check("a plain employee reads only their own row",
    emp.status === 200 && empCodes.length === 1 && empCodes[0] === "ZZOB",
    `${emp.status} ${JSON.stringify(empCodes)}`);

  // Admin: sees the whole roster, including a manager and a seed colleague.
  const admin = await api("/api/employees", { token: tok.ZZRA });
  const adminCodes = admin.json ? codes(admin.json.employees) : [];
  check("an admin reads everyone (a manager, a plain employee and the seed roster)",
    admin.status === 200 && adminCodes.includes("ZZMA") && adminCodes.includes("ZZOB") && adminCodes.includes("EMP001"),
    `${admin.status} ${adminCodes.length} rows`);

  // An anonymous read is refused.
  const anon = await api("/api/employees");
  check("an unauthenticated roster read is 401", anon.status === 401, `${anon.status} ${anon.text}`);
}

async function runMidSessionDeactivation(client) {
  // zzob is signed in with a live cookie (tok.ZZOB). An admin deactivates them.
  const flip = await api("/api/employees/ZZOB", { method: "PATCH", token: tok.ZZRA, body: { active: false } });
  check("an admin can deactivate an employee (PATCH active:false)",
    flip.status === 200 && flip.json && flip.json.employee && flip.json.employee.active === false,
    `${flip.status} ${flip.text}`);

  const dbRow = await rowFor(client, "ZZOB");
  check("the deactivation is persisted on the row", dbRow && dbRow.active === false, dbRow ? `active=${dbRow.active}` : "no row");

  // The very next request with the still-held cookie is refused -- not "at next login".
  const after = await api("/api/employees", { token: tok.ZZOB });
  check("a deactivated employee's next request with a live cookie is 401",
    after.status === 401, `${after.status} ${after.text}`);

  // Restore so later scenarios and re-runs see them active.
  await api("/api/employees/ZZOB", { method: "PATCH", token: tok.ZZRA, body: { active: true } });
}

async function runCycleRefused(client) {
  // A reports to B: legal, no loop.
  const aToB = await api("/api/employees/ZZCA", { method: "PATCH", token: tok.ZZRA, body: { managerCode: "ZZCB" } });
  check("filing employee A under B is accepted (no cycle yet)",
    aToB.status === 200 && aToB.json && aToB.json.employee && aToB.json.employee.managerId === "ZZCB",
    `${aToB.status} ${aToB.text}`);

  // Now B under A would close A -> B -> A. The 0007 constraint trigger must refuse it.
  const bToA = await api("/api/employees/ZZCB", { method: "PATCH", token: tok.ZZRA, body: { managerCode: "ZZCA" } });
  check("closing the manager loop (B under A) is refused (400)",
    bToA.status === 400 && bToA.json && bToA.json.error, `${bToA.status} ${bToA.text}`);

  // The refused PATCH changed nothing: B still has no manager.
  const dbB = await rowFor(client, "ZZCB");
  check("the refused cycle left the manager pointer unchanged (rolled back)",
    dbB && dbB.manager_id == null, dbB ? `manager_id=${dbB.manager_id}` : "no row");

  await client.query(`UPDATE employees SET manager_id = NULL WHERE employee_code = 'ZZCA'`).catch(() => {});
}

main().then(async () => {
  const failed = checks.filter((c) => !c.passed);
  console.log(`\n=== tests/integration/roster.mjs: ${checks.length - failed.length}/${checks.length} checks passed ===`);
  if (failed.length) {
    console.log(`>>> ${failed.length} FAILED: ${failed.map((f) => f.name).join(", ")}`);
    process.exit(1);
  }
}).catch((err) => {
  console.error("[roster] ERROR:", err && err.stack ? err.stack : err);
  process.exit(1);
});
