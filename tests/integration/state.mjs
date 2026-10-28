/**
 * tests/integration/state.mjs -- the /api/state document facade (D1), over the wire.
 *
 * It drives the compiled GET /api/state and PUT /api/state/{key} handlers against the served
 * standalone build (the same payload probe/auth/punches/roster run) and verifies each claim
 * the browser's js/api.js depends on, using the real state_documents table for the parts a
 * response cannot prove:
 *
 *   1. optimistic concurrency  -- a fresh key creates version 1; the matching baseVersion
 *      advances it; a stale baseVersion is a 409 carrying currentValue/currentVersion so the
 *      tab can adopt the winner instead of overwriting them.
 *   2. who may write which key -- an admin-only store is 403 for a plain employee and 200 for
 *      an admin; a self-service store is writable by anyone signed in.
 *   3. the credential store is never client-writable and never leaked -- PUT vkon_admin_creds_v6
 *      is 403 even for an admin, and GET omits it.
 *   4. a monotonic serverVersion -- the counter the browser compares in pull() advances on a
 *      successful write.
 *   5. the transport guards -- an unknown/non-shared key is 400, an unauthenticated write 401.
 *
 * Usage: node tests/integration/state.mjs   (needs a served app at PROBE_BASE_URL)
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

/* --------------------------------------------------------------- throwaway accounts */

const USERS = {
  admin: { code: "ZZSA", username: "zzsa", name: "St Admin", pw: "State-Admin-99", role: "admin" },
  emp:   { code: "ZZSE", username: "zzse", name: "St Employee", pw: "State-Emp-99", role: "employee" },
};

// Keys the suite writes, so it can clean them out of the table afterwards.
const WRITTEN_KEYS = ["vkon_leaves_v6", "vkon_settings_v6"];

const tok = {}; // code -> session token

async function upsertUser(client, spec) {
  const hash = await bcrypt.hash(preHash(spec.pw), COST);
  await client.query(
    `INSERT INTO employees
       (employee_code, username, name, email, role, active, password_hash, password_change_required, monthly_salary, geofence_enabled, timezone)
     VALUES ($1, $2, $3, $4, $5, TRUE, $6, FALSE, 50000.00, TRUE, 'Asia/Kolkata')
     ON CONFLICT (username) DO UPDATE
       SET active = TRUE, password_hash = EXCLUDED.password_hash, password_change_required = FALSE,
           role = EXCLUDED.role, updated_at = now()
     RETURNING id`,
    [spec.code, spec.username, spec.name, `${spec.username}@example.test`, spec.role, hash],
  );
}

/* ------------------------------------------------------------------------- the suite */

async function main() {
  if (!BASE) { console.log("SKIPPED tests/integration/state.mjs (PROBE_BASE_URL not set -- run it in the serve phase)"); return; }
  if (!APP_URL) { console.log("SKIPPED tests/integration/state.mjs (DATABASE_URL_APP not set)"); return; }

  let client;
  try {
    client = new Client({ connectionString: APP_URL, application_name: "vkon-attendance-state-test" });
    await client.connect();
  } catch (e) {
    console.log(`SKIPPED tests/integration/state.mjs (cannot reach the app database: ${e.message})`);
    return;
  }

  try {
    await client.query("BEGIN");
    for (const u of Object.values(USERS)) await upsertUser(client, u);
    await client.query("COMMIT");
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
    await runConcurrency();
    await runRoleGates();
    await runCredentialStoreSuppressed(client);
    await runTransportGuards();
  } finally {
    await client.query(`DELETE FROM state_documents WHERE key = ANY($1)`, [WRITTEN_KEYS]).catch(() => {});
    await client.query(
      `UPDATE employees SET active = FALSE, password_hash = NULL
        WHERE username IN ('zzsa','zzse')`,
    ).catch(() => {});
    await client.query(
      `DELETE FROM sessions WHERE employee_id IN
         (SELECT id FROM employees WHERE username IN ('zzsa','zzse'))`,
    ).catch(() => {});
    await client.end().catch(() => {});
  }
}

async function runConcurrency() {
  // Fresh key: baseVersion 0 creates it at version 1.
  const created = await api("/api/state/vkon_leaves_v6", {
    method: "PUT", token: tok.ZZSE, body: { baseVersion: 0, value: { L: [1, 2, 3] } },
  });
  check("a fresh key with baseVersion 0 creates version 1",
    created.status === 200 && created.json && created.json.version === 1,
    `${created.status} ${created.text}`);

  // Matching baseVersion advances it.
  const advanced = await api("/api/state/vkon_leaves_v6", {
    method: "PUT", token: tok.ZZSE, body: { baseVersion: 1, value: { L: [1, 2, 3, 4] } },
  });
  check("the matching baseVersion advances to version 2",
    advanced.status === 200 && advanced.json && advanced.json.version === 2,
    `${advanced.status} ${advanced.text}`);

  // A stale baseVersion is a 409 that carries the winner's value and version.
  const conflict = await api("/api/state/vkon_leaves_v6", {
    method: "PUT", token: tok.ZZSE, body: { baseVersion: 1, value: { hijack: true } },
  });
  const err = conflict.json && conflict.json.error;
  check("a stale baseVersion is 409 with reason version_conflict",
    conflict.status === 409 && err && err.reason === "version_conflict",
    `${conflict.status} ${conflict.text}`);
  check("the 409 carries currentValue and currentVersion the tab can adopt",
    err && "currentValue" in err && err.currentVersion === 2 &&
    err.currentValue && Array.isArray(err.currentValue.L) && err.currentValue.L.length === 4,
    `${conflict.status} ${JSON.stringify(err)}`);

  // The monotonic counter js/api.js pull() compares advances on a successful write.
  const state = await api("/api/state", { token: tok.ZZSE });
  check("GET /api/state returns stores + a numeric serverVersion",
    state.status === 200 && state.json && state.json.stores &&
    typeof state.json.serverVersion === "number" && state.json.serverVersion >= 2,
    `${state.status} ${state.text}`);
}

async function runRoleGates() {
  // A self-service store is writable by any signed-in account (already shown above).
  // An admin-only store is refused for a plain employee.
  const empTry = await api("/api/state/vkon_settings_v6", {
    method: "PUT", token: tok.ZZSE, body: { baseVersion: 0, value: { attendance: {} } },
  });
  check("a plain employee writing an admin-only store is 403",
    empTry.status === 403 && empTry.json && empTry.json.error,
    `${empTry.status} ${empTry.text}`);

  // ...and accepted for an admin.
  const adminTry = await api("/api/state/vkon_settings_v6", {
    method: "PUT", token: tok.ZZSA, body: { baseVersion: 0, value: { payrollCutOffDay: 5 } },
  });
  check("an admin writing an admin-only store is 200 (version 1)",
    adminTry.status === 200 && adminTry.json && adminTry.json.version === 1,
    `${adminTry.status} ${adminTry.text}`);
}

async function runCredentialStoreSuppressed(client) {
  // The admin credential store is never client-writable, not even by an admin.
  const deny = await api("/api/state/vkon_admin_creds_v6", {
    method: "PUT", token: tok.ZZSA, body: { baseVersion: 0, value: { u: "x" } },
  });
  check("PUT vkon_admin_creds_v6 is 403 even for an admin (document_not_writable)",
    deny.status === 403 && deny.json && deny.json.error && deny.json.error.reason === "document_not_writable",
    `${deny.status} ${deny.text}`);

  // ...and it never appears in the read projection.
  const state = await api("/api/state", { token: tok.ZZSE });
  const stores = (state.json && state.json.stores) || {};
  check("GET /api/state omits vkon_admin_creds_v6", !("vkon_admin_creds_v6" in stores),
    Object.keys(stores).join(","));
  check("GET /api/state includes the writable stores just published",
    "vkon_leaves_v6" in stores && "vkon_settings_v6" in stores,
    Object.keys(stores).join(","));
}

async function runTransportGuards() {
  // A non-shared key (no vkon_ prefix) is refused at the edge, before classification.
  const badKey = await api("/api/state/not_a_shared_key", {
    method: "PUT", token: tok.ZZSE, body: { baseVersion: 0, value: {} },
  });
  check("a non-shared key is 400, not written",
    badKey.status === 400 && badKey.json && badKey.json.error,
    `${badKey.status} ${badKey.text}`);

  // The offline punch queue is drained via /api/punches, never accepted as a document.
  const queue = await api("/api/state/vkon_punch_queue_v1", {
    method: "PUT", token: tok.ZZSE, body: { baseVersion: 0, value: [] },
  });
  check("the punch queue key is refused (400)", queue.status === 400,
    `${queue.status} ${queue.text}`);

  // A missing `value` is a malformed command.
  const noValue = await api("/api/state/vkon_leaves_v6", {
    method: "PUT", token: tok.ZZSE, body: { baseVersion: 2 },
  });
  check("a PUT without `value` is 400", noValue.status === 400, `${noValue.status} ${noValue.text}`);

  // An unauthenticated write has no identity to authorise against.
  const anon = await api("/api/state/vkon_leaves_v6", {
    method: "PUT", body: { baseVersion: 2, value: {} },
  });
  check("an unauthenticated state write is 401", anon.status === 401, `${anon.status} ${anon.text}`);

  // An unauthenticated read is refused too (the login screen uses /auth/me, not /state).
  const anonRead = await api("/api/state");
  check("an unauthenticated state read is 401", anonRead.status === 401, `${anonRead.status} ${anonRead.text}`);
}

main().then(async () => {
  const failed = checks.filter((c) => !c.passed);
  console.log(`\n=== tests/integration/state.mjs: ${checks.length - failed.length}/${checks.length} checks passed ===`);
  if (failed.length) {
    console.log(`>>> ${failed.length} FAILED: ${failed.map((f) => f.name).join(", ")}`);
    process.exit(1);
  }
}).catch((err) => {
  console.error("[state] ERROR:", err && err.stack ? err.stack : err);
  process.exit(1);
});
