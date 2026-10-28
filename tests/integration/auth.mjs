/**
 * tests/integration/auth.mjs -- M3: the auth vertical slice, over the wire.
 *
 * This drives the compiled route handlers through HTTP, against the same standalone
 * payload `next build` ships and the probe runs, and it verifies the decision against the
 * real sessions/employees tables. The plan's five claims, each turned into a check that
 * fails when the property is untrue:
 *
 *   1. equal-time unknown-user path      -- measure, assert within tolerance.
 *   2. no user enumeration in text        -- unknown / wrong-password / inactive share one
 *                                           401 sentence, and it names no field.
 *   3. inactive employee dropped mid-session -- flip active=false, next request is out.
 *   4. expiry enforced                    -- idle deadline and the derived absolute one.
 *   5. password change revokes others     -- the kept session lives, its siblings die.
 *
 * It also asserts the two shapes that are contracts with the front end: the Set-Cookie
 * attribute string (HttpOnly, SameSite=Lax, Path=/, host-only) and the `{error:{message}}`
 * body js/api.js reads.
 *
 * Why it talks HTTP rather than importing the modules: the auth code is TypeScript. A
 * plain `.mjs` test cannot import it, and adding a TS loader to the runtime dependency
 * list is exactly the bloat this project keeps out. The route handlers compile to the
 * standalone build already under test, so HTTP tests the real thing and nothing extra.
 *
 * The throwaway employees are created and neutralised through the app role, the same one
 * the API uses. They are never deleted: an employee with an audit trail cannot be removed
 * without touching audit_log, which is append-only by a trigger that fires for everybody
 * (0005_audit.sql). Cleanup instead drops their sessions and clears the hash and the
 * active flag, leaving inert, sign-in-incapable rows -- and, crucially, no row with a
 * password_hash that the seed guard in tests/integration/db.mjs would later flag.
 *
 * The stored hashes are made at the server's own cost factor (BCRYPT_COST_FACTOR, same
 * default, same env) so the unknown-user dummy comparison and a known-user comparison cost
 * the same; hashing them cheaper would make the timing test fail for a reason that has
 * nothing to do with the property it is checking.
 *
 * Usage: node tests/integration/auth.mjs   (needs a served app at PROBE_BASE_URL)
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

// The same pre-hash lib/auth/hash.ts applies: SHA-256, base64. Keep them in step.
const preHash = (pw) => createHash("sha256").update(pw, "utf8").digest("base64");
const tokenHash = (token) => createHash("sha256").update(token, "utf8").digest("hex");

/* --------------------------------------------------------------------- HTTP helpers */

async function api(path, { method = "GET", body, token } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Cookie = `${COOKIE_NAME}=${token}`;
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: "manual",
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON; caller inspects text */ }
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

/** Log in and hand back the response fields plus the parsed token. */
async function login(identifier, password) {
  const res = await api("/api/auth/login", { method: "POST", body: { identifier, password } });
  return { ...res, res, token: tokenFrom(res) };
}

async function timed(identifier, password) {
  const t0 = performance.now();
  const r = await login(identifier, password);
  return { ms: performance.now() - t0, status: r.status, token: r.token, json: r.json };
}

const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

/* --------------------------------------------------------------- throwaway employees */

// Fixed identities, reused across runs (UPSERT) and neutralised in `finally`. Codes are
// upper-case and usernames lower-case because 0002_core.sql CHECKs exactly that.
const USERS = {
  active:   { code: "ZZTA",  username: "zzta",  name: "A Authprobe", pw: "Alpha-Signin-99" },
  deactivate: { code: "ZZTB", username: "zztb", name: "B Authprobe", pw: "Beta-Signin-99" },
  change:   { code: "ZZTB2", username: "zztb2", name: "C Authprobe", pw: "Bravo-Signin-99" },
  inactive: { code: "ZZTC",  username: "zztc",  name: "D Authprobe", pw: "Gamma-Signin-99" },
  forced:   { code: "ZZTD",  username: "zztd",  name: "E Authprobe", pw: "Delta-Signin-99" },
};
const NEW_PW = "Rotated-Secret-123";

async function upsertUser(client, spec, { active = true, forced = false } = {}) {
  const hash = await bcrypt.hash(preHash(spec.pw), COST);
  const id = await client.query(
    `INSERT INTO employees
       (employee_code, username, name, role, active, password_hash, password_change_required, monthly_salary, timezone)
     VALUES ($1, $2, $3, 'employee', $4, $5, $6, 50000.00, 'Asia/Kolkata')
     ON CONFLICT (username) DO UPDATE
       SET active = EXCLUDED.active,
           password_hash = EXCLUDED.password_hash,
           password_change_required = EXCLUDED.password_change_required,
           updated_at = now()
     RETURNING id`,
    [spec.code, spec.username, spec.name, active, hash, forced],
  );
  return id.rows[0].id;
}

async function setSessionState(client, token, sql, params) {
  await client.query(sql, [tokenHash(token), ...params]);
}

async function signOutEverything(client, username) {
  await client.query(
    `DELETE FROM sessions WHERE employee_id = (SELECT id FROM employees WHERE username = $1)`,
    [username],
  );
}

/* ------------------------------------------------------------------------- the suite */

async function main() {
  if (!BASE) {
    console.log("SKIPPED tests/integration/auth.mjs (PROBE_BASE_URL not set -- run it in the serve phase)");
    return;
  }
  if (!APP_URL) {
    console.log("SKIPPED tests/integration/auth.mjs (DATABASE_URL_APP not set)");
    return;
  }

  let client;
  try {
    client = new Client({ connectionString: APP_URL, application_name: "vkon-attendance-auth-test" });
    await client.connect();
  } catch (e) {
    console.log(`SKIPPED tests/integration/auth.mjs (cannot reach the app database: ${e.message})`);
    return;
  }

  try {
    await client.query("BEGIN");
    for (const u of Object.values(USERS)) await upsertUser(client, u);
    await upsertUser(client, USERS.inactive, { active: false });
    await upsertUser(client, USERS.forced, { forced: true });
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  }

  try {
    /* ------------------------------------------ boot + cookie + error-shape contracts */
    await runContracts();

    /* ----------------------------------------------- enumeration text and equal timing */
    await runEnumeration();

    /* -------------------------------------------------------- mid-session, expiry, revoke */
    await runLifecycle();
  } finally {
    /* Neutralise: no hash a later guard could flag, cannot sign in, sessions gone. The
       employees themselves stay -- deleting them would mean touching audit_log. */
    for (const u of Object.values(USERS)) {
      await signOutEverything(client, u.username).catch(() => {});
    }
    await client.query(
      `UPDATE employees SET active = FALSE, password_hash = NULL, password_change_required = FALSE
        WHERE username IN ('zzta','zztb','zztb2','zztc','zztd')`,
    ).catch(() => {});
    await client.end().catch(() => {});
  }
}

async function runContracts() {
  // GET /me with no cookie: the login screen has to be able to ask whether a server exists.
  const anon = await api("/api/auth/me");
  check("GET /me with no cookie is 200 {signedIn:false}",
    anon.status === 200 && anon.json && anon.json.signedIn === false,
    `${anon.status} ${anon.text}`);

  const good = await login(USERS.active.username, USERS.active.pw);
  check("login issues 200 and a session cookie",
    good.res.status === 200 && good.token && good.json && good.json.signedIn === true,
    `${good.res.status} ${good.res.text}`);

  // The cookie attributes, straight off the wire.
  const cookieLine = good.res.setCookies.find((c) => c.startsWith(`${COOKIE_NAME}=`)) || "";
  check("session cookie is HttpOnly, SameSite=Lax, Path=/ and host-only",
    /HttpOnly/.test(cookieLine) && /SameSite=Lax/.test(cookieLine) &&
    /Path=\//.test(cookieLine) && !/\bDomain=/i.test(cookieLine) && !/Max-Age=/i.test(cookieLine),
    cookieLine);

  // employeeId in the body is the portal's own key, "ZZTA", not the uuid -- D1's seam.
  check("session body carries the employee code as employeeId",
    good.json && String(good.json.employeeId) === USERS.active.code,
    JSON.stringify(good.json));

  const me = await api("/api/auth/me", { token: good.token });
  check("GET /me with a valid cookie returns the session",
    me.status === 200 && me.json && me.json.signedIn === true && me.json.employeeId === USERS.active.code,
    `${me.status} ${me.text}`);

  // A failed sign-in clears the cookie it just rejected.
  const bad = await login(USERS.active.username, "wrong-password-entirely");
  const clearLine = bad.res.setCookies.find((c) => c.startsWith(`${COOKIE_NAME}=`)) || "";
  check("a rejected sign-in returns a Max-Age=0 clear cookie",
    bad.res.status === 401 && /Max-Age=0/.test(clearLine), clearLine || bad.res.text);

  // Logout ends the session on the server and in the browser.
  const after = tokenFrom(bad.res); // null (cleared)
  const liveTok = good.token;
  const out = await api("/api/auth/logout", { method: "POST", token: liveTok });
  const meAfter = await api("/api/auth/me", { token: liveTok });
  check("logout 200 and the token no longer resolves",
    out.status === 200 && !after && meAfter.json && meAfter.json.signedIn === false,
    `${out.status} / ${meAfter.status} ${meAfter.text}`);
}

async function runEnumeration() {
  // Warm the dummy hash and the pool so a first-call cost is not mistaken for a signal.
  await login("zz-never-a-real-account", "warm-me-up-please-1");
  await login(USERS.active.username, "warm-wrong-password-1");

  const INVALID = (await login(USERS.active.username, "definitely-not-the-password")).json;
  const unknown = await login("zz-never-a-real-account", "whatever-1234567");
  const wrong = await login(USERS.active.username, "definitely-not-the-password");
  const inactive = await login(USERS.inactive.username, USERS.inactive.pw); // correct pw, dead account

  const msg = (r) => (r.json && r.json.error && r.json.error.message) || `(${r.status} ${r.text})`;

  check("unknown user, wrong password and an inactive account are one identical sentence",
    unknown.res.status === 401 && wrong.res.status === 401 && inactive.res.status === 401 &&
    msg(unknown) === msg(wrong) && msg(wrong) === msg(inactive) && !!INVALID.error && !!INVALID.error.message,
    `unknown="${msg(unknown)}" wrong="${msg(wrong)}" inactive="${msg(inactive)}"`);

  check("the 401 body names no field and reveals no reason",
    unknown.res.json && Object.keys(unknown.res.json.error).sort().join(",") === "message",
    JSON.stringify(unknown.res.json && unknown.res.json.error));

  // Equal time. Both paths run exactly one bcrypt comparison (a real account's hash, or
  // the dummy), so the medians land together. Tolerance is deliberately wide in absolute
  // terms and generous as a ratio: the point is the absence of a 3x gap, not sub-frame
  // symmetry on a shared laptop.
  const N = 5;
  const tUnknown = [];
  const tWrong = [];
  for (let i = 0; i < N; i++) {
    tUnknown.push((await timed("zz-never-a-real-account", `probe-${i}-password`)).ms);
    tWrong.push((await timed(USERS.active.username, `probe-${i}-wrongpw`)).ms);
  }
  const mUnknown = median(tUnknown);
  const mWrong = median(tWrong);
  const ratio = mUnknown / mWrong;
  const diffMs = Math.abs(mUnknown - mWrong);
  check("unknown-user and wrong-password cost the same (within tolerance)",
    ratio > 0.5 && ratio < 2.0 && diffMs < 400,
    `median unknown=${mUnknown.toFixed(0)}ms, wrong=${mWrong.toFixed(0)}ms, ratio=${ratio.toFixed(2)}, diff=${diffMs.toFixed(0)}ms`);
}

async function runLifecycle() {
  /* ---- mid-session deactivation: the whole reason identity is read from the DB per request */
  const b = await login(USERS.deactivate.username, USERS.deactivate.pw);
  const meBefore = await api("/api/auth/me", { token: b.token });

  // Flip the account off, then show the live cookie stops working on its next request.
  const c = new Client({ connectionString: APP_URL, application_name: "vkon-attendance-auth-test-deact" });
  await c.connect();
  await c.query(`UPDATE employees SET active = FALSE WHERE username = 'zztb'`);
  await c.end();

  const meAfter = await api("/api/auth/me", { token: b.token });
  check("a deactivated account is dropped mid-session, not at next login",
    meBefore.json && meBefore.json.signedIn === true && meAfter.json && meAfter.json.signedIn === false,
    `${meBefore.status} -> ${meAfter.status} ${meAfter.text}`);

  // And it cannot sign back in.
  const relogin = await login(USERS.deactivate.username, USERS.deactivate.pw);
  check("the deactivated account can no longer sign in",
    relogin.res.status === 401 && !relogin.token, `${relogin.res.status} ${relogin.res.text}`);

  /* ---------------------------------------------------------------- expiry (idle and absolute) */
  const a = await login(USERS.active.username, USERS.active.pw);
  const e = new Client({ connectionString: APP_URL, application_name: "vkon-attendance-auth-test-exp" });
  await e.connect();
  try {
    // Idle deadline in the past.
    await setSessionState(e, a.token, `UPDATE sessions SET expires_at = now() - interval '1 minute' WHERE token_hash = $1`, []);
    const meIdle = await api("/api/auth/me", { token: a.token });
    check("a session past its idle deadline is rejected",
      meIdle.json && meIdle.json.signedIn === false, `${meIdle.status} ${meIdle.text}`);

    // Absolute deadline, derived from created_at, even while the idle clock still reads valid.
    await setSessionState(e, a.token,
      `UPDATE sessions SET created_at = now() - interval '40 hours', expires_at = now() + interval '10 hours' WHERE token_hash = $1`, []);
    const meAbs = await api("/api/auth/me", { token: a.token });
    check("a session past its absolute deadline is rejected while the idle clock reads valid",
      meAbs.json && meAbs.json.signedIn === false, `${meAbs.status} ${meAbs.text}`);
  } finally {
    await e.end().catch(() => {});
  }

  /* ------------------------------------- password change revokes every other session */
  const dev1 = await login(USERS.change.username, USERS.change.pw);
  const dev2 = await login(USERS.change.username, USERS.change.pw);
  check("two sign-ins yield two distinct sessions",
    dev1.token && dev2.token && dev1.token !== dev2.token, "cookies equal?");

  const list = await api("/api/auth/sessions", { token: dev1.token });
  const cur = (list.json && list.json.sessions || []).find((s) => s.current);
  check("GET /sessions lists the account's live sessions and marks the current one",
    list.status === 200 && (list.json.sessions.length >= 2) && cur && cur.current === true,
    `${list.status} ${list.text}`);

  const change = await api("/api/auth/password", {
    method: "POST",
    token: dev1.token,
    body: { currentPassword: USERS.change.pw, newPassword: NEW_PW },
  });
  check("changing the password succeeds and reports the other sessions revoked",
    change.status === 200 && change.json && change.json.ok === true && change.json.sessionsRevoked >= 1,
    `${change.status} ${change.text}`);

  const kept = await api("/api/auth/me", { token: dev1.token });
  const other = await api("/api/auth/me", { token: dev2.token });
  check("the current session survives; the other is revoked",
    kept.json && kept.json.signedIn === true && other.json && other.json.signedIn === false,
    `kept=${kept.status} other=${other.status} ${other.text}`);

  const newLogin = await login(USERS.change.username, NEW_PW);
  const oldLogin = await login(USERS.change.username, USERS.change.pw);
  check("the new password signs in and the old one no longer does",
    newLogin.res.status === 200 && oldLogin.res.status === 401,
    `new=${newLogin.res.status} old=${oldLogin.res.status}`);

  /* ------------------------------------------------- the forced first-change door (admin case) */
  const f = await login(USERS.forced.username, USERS.forced.pw);
  check("a forced-change account signs in with mustChangePassword true",
    f.res.status === 200 && f.json && f.json.mustChangePassword === true, `${f.res.status} ${f.res.text}`);

  // The forced change needs no current password: the verified one-time sign-in is the proof.
  const forced = await api("/api/auth/password", {
    method: "POST", token: f.token, body: { newPassword: "Fresh-First-Secret-9" },
  });
  check("a forced change may omit the current password",
    forced.status === 200 && forced.json && forced.json.ok === true, `${forced.status} ${forced.text}`);
}

main().then(async () => {
  const failed = checks.filter((c) => !c.passed);
  console.log(`\n=== tests/integration/auth.mjs: ${checks.length - failed.length}/${checks.length} checks passed ===`);
  if (failed.length) {
    console.log(`>>> ${failed.length} FAILED: ${failed.map((f) => f.name).join(", ")}`);
    process.exit(1);
  }
}).catch((err) => {
  console.error("[auth] ERROR:", err && err.stack ? err.stack : err);
  process.exit(1);
});
