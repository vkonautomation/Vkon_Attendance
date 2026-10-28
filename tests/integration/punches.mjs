/**
 * tests/integration/punches.mjs -- M6: the punch vertical slice, over the wire.
 *
 * It drives the compiled /api/punches handlers through HTTP against the standalone build
 * (the same payload the probe and auth suites run), and verifies each outcome against the
 * real `records` table with the app role. The plan names three claims and each becomes a
 * check that fails when the property is untrue:
 *
 *   1. a replayed queue flush creates one row   -- the same punch_id POSTed twice leaves
 *      exactly one row; the second response says `duplicate: true`.
 *   2. a punch with accuracy worse than the configured threshold is refused -- the fence
 *      will not place the person on site; the response is insideGeofence:false and the note
 *      names the accuracy limit. (Fail-closed but still recorded: the absence of a good fix
 *      is not evidence of absence, matching presence.py -- the punch is evidence, flagged.)
 *   3. a tab left open past midnight yields yesterday's close and today's open -- an open
 *      earlier day is closed at the midnight boundary when today's check-in arrives, and
 *      today's row opens; the response names the day it just closed.
 *
 * Plus the two authorisation rules carried over from the outgoing backend (server/api.py):
 * an employee may only book their own punches, and an unauthenticated punch is refused.
 *
 * Usage: node tests/integration/punches.mjs   (needs a served app at PROBE_BASE_URL)
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

// The office the seed draws the fence around, and a fix that lands squarely inside it.
const OFFICE = { lat: 12.9716, lng: 77.5946 };
const INSIDE = { latitude: OFFICE.lat, longitude: OFFICE.lng, accuracyM: 10 };

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

/* ------------------------------------------------------ the server's IST day arithmetic */

// Mirror istDateKey: the Asia/Kolkata calendar key for an instant.
function istDateKey(date) {
  const p = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(date);
  const y = p.find((x) => x.type === "year").value;
  const m = p.find((x) => x.type === "month").value;
  const d = p.find((x) => x.type === "day").value;
  return `${y}-${m}-${d}`;
}
// The IST calendar day before `key`, by stepping the UTC-anchored noon of that day back.
function prevDayKey(key) {
  const noon = new Date(`${key}T06:30:00Z`); // = 12:00 IST of `key`
  return istDateKey(new Date(noon.getTime() - 86_400_000));
}

/* --------------------------------------------------------------- throwaway employees */

const USERS = {
  idem:     { code: "ZZPA", username: "zzpa",  name: "A Punchprobe", pw: "Alpha-Punch-99" },
  accuracy: { code: "ZZPB", username: "zzpb",  name: "B Punchprobe", pw: "Bravo-Punch-99" },
  rollover: { code: "ZZPC", username: "zzpc",  name: "C Punchprobe", pw: "Charlie-Punch-99" },
  admin:    { code: "ZZAD", username: "zzad",  name: "D Punchadmin", pw: "Delta-Punch-99", role: "admin" },
};

async function upsertUser(client, spec) {
  const hash = await bcrypt.hash(preHash(spec.pw), COST);
  const id = await client.query(
    `INSERT INTO employees
       (employee_code, username, name, role, active, password_hash, password_change_required, monthly_salary, timezone, geofence_enabled)
     VALUES ($1, $2, $3, $4, TRUE, $5, FALSE, 50000.00, 'Asia/Kolkata', TRUE)
     ON CONFLICT (username) DO UPDATE
       SET active = TRUE, password_hash = EXCLUDED.password_hash,
           password_change_required = FALSE, role = EXCLUDED.role, updated_at = now()
     RETURNING id`,
    [spec.code, spec.username, spec.name, spec.role || "employee", hash],
  );
  return id.rows[0].id;
}

const codeId = {}; // username -> employee uuid, filled in setup
const tok = {};    // employee code -> session cookie token, filled in setup

async function clearRecords(client, username) {
  await client.query(`DELETE FROM records WHERE employee_id = $1`, [codeId[username]]);
}

function punchBody(spec, kind, extra = {}) {
  return {
    punchId: extra.punchId || `${spec.code}_${istDateKey(new Date())}_${kind}`,
    kind,
    employeeId: extra.employeeId !== undefined ? extra.employeeId : spec.code,
    clientCapturedAt: extra.clientCapturedAt || new Date().toISOString(),
    ...INSIDE,
    ...(extra.coords || {}),
  };
}

/* ------------------------------------------------------------------------- the suite */

async function main() {
  if (!BASE) { console.log("SKIPPED tests/integration/punches.mjs (PROBE_BASE_URL not set -- run it in the serve phase)"); return; }
  if (!APP_URL) { console.log("SKIPPED tests/integration/punches.mjs (DATABASE_URL_APP not set)"); return; }

  let client;
  try {
    client = new Client({ connectionString: APP_URL, application_name: "vkon-attendance-punch-test" });
    await client.connect();
  } catch (e) {
    console.log(`SKIPPED tests/integration/punches.mjs (cannot reach the app database: ${e.message})`);
    return;
  }

  try {
    await client.query("BEGIN");
    for (const u of Object.values(USERS)) codeId[u.username] = await upsertUser(client, u);
    await client.query("COMMIT");
    for (const u of Object.values(USERS)) await clearRecords(client, u.username);
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  }

  // Signed-in tokens, one per scenario employee.
  for (const u of Object.values(USERS)) {
    const r = await login(u.username, u.pw);
    if (!r.token) throw new Error(`setup: could not sign in ${u.username} (${r.status} ${r.text})`);
    tok[u.code] = r.token;
  }

  try {
    await runIdempotency(client);
    await runAccuracy(client);
    await runRollover(client);
    await runAuthz(client);
  } finally {
    for (const u of Object.values(USERS)) {
      await clearRecords(client, u.username).catch(() => {});
      await client.query(`DELETE FROM sessions WHERE employee_id = $1`, [codeId[u.username]]).catch(() => {});
    }
    await client.query(
      `UPDATE employees SET active = FALSE, password_hash = NULL
        WHERE username IN ('zzpa','zzpb','zzpc','zzad')`,
    ).catch(() => {});
    await client.end().catch(() => {});
  }
}

async function dayRow(client, spec, dayKey) {
  const r = await client.query(
    `SELECT * FROM records WHERE employee_id = $1 AND attendance_day = $2::date`,
    [codeId[spec.username], dayKey],
  );
  return r.rows[0] || null;
}

async function runIdempotency(client) {
  const spec = USERS.idem;
  const dayKey = istDateKey(new Date());
  const inId = `${spec.code}_${dayKey}_in`;

  const first = await api("/api/punches", { method: "POST", token: tok[spec.code], body: punchBody(spec, "in", { punchId: inId }) });
  check("first check-in is accepted and books today's day",
    first.status === 200 && first.json && first.json.duplicate === false &&
    first.json.istDate === dayKey && first.json.employeeId === spec.code && first.json.insideGeofence === true,
    `${first.status} ${first.text}`);

  const second = await api("/api/punches", { method: "POST", token: tok[spec.code], body: punchBody(spec, "in", { punchId: inId }) });
  check("a replayed check-in reports duplicate:true",
    second.status === 200 && second.json && second.json.duplicate === true,
    `${second.status} ${second.text}`);

  const rows = await client.query(
    `SELECT count(*)::int AS n FROM records WHERE employee_id = $1 AND punch_id = $2`,
    [codeId[spec.username], inId],
  );
  const dayRows = await client.query(
    `SELECT count(*)::int AS n FROM records WHERE employee_id = $1 AND attendance_day = $2::date`,
    [codeId[spec.username], dayKey],
  );
  check("the replay created no second row (one punch_id, one day-row)",
    rows.rows[0].n === 1 && dayRows.rows[0].n === 1,
    `punch_id rows=${rows.rows[0].n} day rows=${dayRows.rows[0].n}`);

  // An out-punch closes the same row it opened, not a new one.
  const outId = `${spec.code}_${dayKey}_out`;
  const out = await api("/api/punches", { method: "POST", token: tok[spec.code], body: punchBody(spec, "out", { punchId: outId }) });
  const afterOut = await dayRow(client, spec, dayKey);
  check("a check-out closes the open row (no new day-row) and stamps the punch",
    out.status === 200 && out.json.duplicate === false && afterOut &&
    afterOut.check_in_at != null && afterOut.check_out_at != null &&
    afterOut.check_out_punch_id === outId,
    `${out.status} ${out.text}`);
}

async function runAccuracy(client) {
  const spec = USERS.accuracy;
  const dayKey = istDateKey(new Date());
  // A fix the device itself reports as 5 km wide: coarser than the 100 m trust limit.
  const body = punchBody(spec, "in", { coords: { latitude: OFFICE.lat, longitude: OFFICE.lng, accuracyM: 5000 } });
  const res = await api("/api/punches", { method: "POST", token: tok[spec.code], body });

  check("a coarse-accuracy punch is refused by the fence (insideGeofence:false)",
    res.status === 200 && res.json && res.json.insideGeofence === false,
    `${res.status} ${res.text}`);

  const note = (res.json && res.json.note) || "";
  check("the refusal note names the accuracy limit",
    /accuracy/i.test(note) && /100/.test(note),
    note);

  const row = await dayRow(client, spec, dayKey);
  check("the refused punch is still recorded as evidence, with its coordinates stored",
    row != null && row.check_in_at != null && Number(row.check_in_accuracy_m) === 5000,
    row ? `lat=${row.check_in_lat} acc=${row.check_in_accuracy_m}` : "no row");

  // And the GET projection recomputes the same refusal from stored coordinates.
  const list = await api(`/api/punches?employeeId=${spec.code}&date=${dayKey}`, { token: tok[spec.code] });
  const listed = list.json && list.json.punches && list.json.punches.find((p) => p.istDate === dayKey);
  check("GET /punches recomputes the same server-side verdict from the stored fix",
    list.status === 200 && listed && listed.insideGeofence === false,
    `${list.status} ${list.text}`);
}

async function runRollover(client) {
  const spec = USERS.rollover;
  const todayKey = istDateKey(new Date());
  const yesterdayKey = prevDayKey(todayKey);

  // Leave yesterday open: a check-in with no check-out (the forgotten punch-out tab).
  await client.query(
    `INSERT INTO records (employee_id, attendance_day, check_in_at, source, punch_id, check_in_lat, check_in_lng)
     VALUES ($1, $2::date, $3, 'punch', $4, $5, $6)`,
    [codeId[spec.username], yesterdayKey, `${yesterdayKey}T09:00:00+05:30`, `${spec.code}_${yesterdayKey}_in`, OFFICE.lat, OFFICE.lng],
  );

  // Punching in today must close yesterday and open today -- the plan's "yesterday's close
  // and today's open", not an absent day.
  const res = await api("/api/punches", { method: "POST", token: tok[spec.code], body: punchBody(spec, "in") });

  check("today's check-in reports the prior day it closed",
    res.status === 200 && res.json && res.json.closedPriorDay === yesterdayKey && res.json.istDate === todayKey,
    `${res.status} ${res.text}`);

  const yRow = await dayRow(client, spec, yesterdayKey);
  const tRow = await dayRow(client, spec, todayKey);
  const boundary = new Date(`${todayKey}T00:00:00+05:30`).getTime();
  check("yesterday's row is now closed at the midnight boundary",
    yRow && yRow.check_out_at != null && new Date(yRow.check_out_at).getTime() === boundary,
    yRow ? `check_out=${yRow.check_out_at}` : "no yesterday row");
  check("today's row is opened (check-in set, still open)",
    tRow && tRow.check_in_at != null && tRow.check_out_at == null,
    tRow ? `check_in=${tRow.check_in_at}` : "no today row");
}

async function runAuthz(client) {
  // A plain employee may not book a punch for someone else.
  const body = punchBody(USERS.idem, "in", { employeeId: USERS.accuracy.code, punchId: "cross_" + Date.now() });
  const asSelf = await api("/api/punches", { method: "POST", token: tok[USERS.idem.code], body });
  check("an employee punching for another is 403",
    asSelf.status === 403 && asSelf.json && asSelf.json.error,
    `${asSelf.status} ${asSelf.text}`);

  // An admin may.
  const adminBody = punchBody(USERS.idem, "in", { employeeId: USERS.idem.code, punchId: `${USERS.idem.code}_admin_${Date.now()}` });
  const asAdmin = await api("/api/punches", { method: "POST", token: tok[USERS.admin.code], body: adminBody });
  check("an admin may record a punch for another employee",
    asAdmin.status === 200 && asAdmin.json && asAdmin.json.employeeId === USERS.idem.code,
    `${asAdmin.status} ${asAdmin.text}`);

  // No cookie at all.
  const anon = await api("/api/punches", { method: "POST", body: punchBody(USERS.idem, "in") });
  check("an unauthenticated punch is refused (401)",
    anon.status === 401, `${anon.status} ${anon.text}`);

  // A malformed kind.
  const badKind = await api("/api/punches", { method: "POST", token: tok[USERS.idem.code], body: { ...punchBody(USERS.idem, "in"), kind: "middle" } });
  check("a punch whose kind is not in/out is 400",
    badKind.status === 400, `${badKind.status} ${badKind.text}`);
}

main().then(async () => {
  const failed = checks.filter((c) => !c.passed);
  console.log(`\n=== tests/integration/punches.mjs: ${checks.length - failed.length}/${checks.length} checks passed ===`);
  if (failed.length) {
    console.log(`>>> ${failed.length} FAILED: ${failed.map((f) => f.name).join(", ")}`);
    process.exit(1);
  }
}).catch((err) => {
  console.error("[punches] ERROR:", err && err.stack ? err.stack : err);
  process.exit(1);
});
