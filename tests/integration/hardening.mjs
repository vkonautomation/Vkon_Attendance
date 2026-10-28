/**
 * tests/integration/hardening.mjs -- M4: rate limiting, the Origin lock, body limits.
 *
 * This runs against a SECOND served instance started with the hardening configuration
 * (PUBLIC_ORIGIN set, VKON_TRUST_PROXY_HEADERS=true, and the real 5-failure window),
 * separate from the instance auth.mjs drives. The separation is deliberate:
 *
 *   - auth.mjs deliberately makes more than five failed attempts (the timing and
 *     enumeration suites) and sends no Origin. Against the real limits and an enforced
 *     Origin it would fail for reasons that have nothing to do with M3. So the primary
 *     instance runs with the limits lifted and PUBLIC_ORIGIN unset.
 *   - This file needs an enforced Origin and a live limit, and needs to attribute
 *     requests to more than one client address -- which only works with proxy headers
 *     trusted, so it gets its own instance where they are.
 *
 * The three properties the plan names, each turned into a check that fails when the
 * property is untrue:
 *
 *   1. a 6th failed attempt for one account is blocked while a different account signs
 *      in immediately.
 *   2. a POST with a foreign Origin is 403, one with no Origin is 403, and the same POST
 *      with the correct Origin succeeds.
 *   3. a request from a second IP is unaffected by the first IP's lockout.
 *
 * Plus the body ceiling: a sign-in body over MAX_AUTH_BODY_BYTES is refused with 413
 * before anything is parsed.
 *
 * Client addresses come from `cf-connecting-ip` (honoured here because this instance
 * trusts proxy headers), using TEST-NET-3 addresses (203.0.113.0/24, reserved for
 * documentation) so nothing is ever attributed to a routable host. Each scenario uses a
 * distinct address and a distinct account so the two buckets never collide across checks
 * -- a shared address would let one test's lockout leak into the next.
 *
 * Usage: node tests/integration/hardening.mjs  (needs the hardened instance at
 * PROBE_BASE_URL and the app role at DATABASE_URL_APP; skips, exit 0, otherwise)
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
const LIMIT = Number(process.env.RATE_LIMIT_MAX_FAILURES || 5);

const checks = [];
function check(name, passed, detail) {
  checks.push({ name, passed: !!passed, detail });
  console.log(`${passed ? "ok    " : "FAIL  "} ${name}`);
  if (!passed && detail) console.log(`        ${String(detail).split("\n").slice(0, 4).join("\n        ")}`);
}

const preHash = (pw) => createHash("sha256").update(pw, "utf8").digest("base64");

/* --------------------------------------------------------------------- HTTP helpers */

async function api(path, { method = "POST", body, ip, origin, referer } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (ip) headers["cf-connecting-ip"] = ip;
  if (origin !== undefined) headers.Origin = origin;
  if (referer !== undefined) headers.Referer = referer;
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: "manual",
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
  return { status: res.status, json, text };
}

const login = (identifier, password, opts = {}) =>
  api("/api/auth/login", { body: { identifier, password }, ...opts });

/* ------------------------------------------------------------------- throwaway users */

// Fixed identities, reused across runs. Codes upper / usernames lower to satisfy the
// 0002_core.sql CHECKs. Each scenario signs in as its own account so the per-account
// bucket is never shared between two checks.
const USERS = {
  lock:   { code: "ZHLOCK", username: "zhlock",   name: "H Lock",   pw: "Lock-Signin-99" },
  other:  { code: "ZHOTHR", username: "zhothr",   name: "H Other",  pw: "Other-Signin-99" },
  fresh:  { code: "ZHFRES", username: "zhfresh",  name: "H Fresh",  pw: "Fresh-Signin-99" },
  origin: { code: "ZHORGN", username: "zhorigin", name: "H Origin", pw: "Origin-Signin-99" },
};

async function upsertUser(client, spec) {
  const hash = await bcrypt.hash(preHash(spec.pw), COST);
  await client.query(
    `INSERT INTO employees
       (employee_code, username, name, role, active, password_hash, password_change_required, monthly_salary, timezone)
     VALUES ($1, $2, $3, 'employee', TRUE, $4, FALSE, 50000.00, 'Asia/Kolkata')
     ON CONFLICT (username) DO UPDATE
       SET active = TRUE, password_hash = EXCLUDED.password_hash,
           password_change_required = FALSE, updated_at = now()`,
    [spec.code, spec.username, spec.name, hash],
  );
}

/* ------------------------------------------------------------------------ scenarios */

async function runRateLimiting() {
  // Every request here carries the correct Origin: on this instance the guard runs first
  // and would 403 a bare POST before the limit is ever consulted (the Origin behaviour is
  // the separate runOriginCheck scenario).
  const opts = (ip) => ({ ip, origin: BASE });

  // 1. Five failures on the lock account from IP1, then a sixth is refused.
  for (let i = 0; i < LIMIT; i++) {
    const r = await login(USERS.lock.username, `wrong-${i}`, opts("203.0.113.10"));
    if (r.status !== 401) {
      check(`attempt ${i + 1} of the pre-lock window is a plain 401`, false, `${r.status} ${r.text}`);
      return;
    }
  }
  const sixth = await login(USERS.lock.username, "wrong-after-window", opts("203.0.113.10"));
  check("the 6th failed attempt on one account is rate limited (429)",
    sixth.status === 429, `${sixth.status} ${sixth.text}`);
  check("a 429 carries the {error:{message}} shape the front end reads",
    sixth.json && sixth.json.error && typeof sixth.json.error.message === "string",
    sixth.text);

  // 2. A different account signs in immediately (different account, different IP).
  const other = await login(USERS.other.username, USERS.other.pw, opts("203.0.113.11"));
  check("a different account still signs in while the first is locked",
    other.status === 200, `${other.status} ${other.text}`);

  // 3. The account lock follows the account, not the address: the locked account from a
  //    clean address is still refused.
  const lockFromCleanIp = await login(USERS.lock.username, USERS.lock.pw, opts("203.0.113.12"));
  check("the locked account is refused even from a fresh address (per-account bucket)",
    lockFromCleanIp.status === 429, `${lockFromCleanIp.status} ${lockFromCleanIp.text}`);

  // 4. The address lock follows the address, not the account: a brand-new account failing
  //    once from the locked address is refused, and the same from a clean address is not.
  const freshOnLockedIp = await login(USERS.fresh.username, "wrong", opts("203.0.113.10"));
  check("a new account from the locked address is refused (per-IP bucket, not per-account)",
    freshOnLockedIp.status === 429, `${freshOnLockedIp.status} ${freshOnLockedIp.text}`);
  const freshOnCleanIp = await login(USERS.fresh.username, "wrong", opts("203.0.113.13"));
  check("a request from a second IP is unaffected by the first IP's lockout",
    freshOnCleanIp.status === 401, `${freshOnCleanIp.status} ${freshOnCleanIp.text}`);
}

async function runOriginCheck() {
  const expected = BASE; // PUBLIC_ORIGIN is set to this instance's own origin.

  const foreign = await login(USERS.origin.username, USERS.origin.pw, {
    ip: "203.0.114.1", origin: "https://evil.example",
  });
  check("a POST with a foreign Origin is 403", foreign.status === 403, `${foreign.status} ${foreign.text}`);
  check("the 403 names no field and reveals the expected origin in nothing",
    foreign.json && foreign.json.error && typeof foreign.json.error.message === "string" &&
    !JSON.stringify(foreign.json).includes(expected),
    foreign.text);

  const missing = await login(USERS.origin.username, USERS.origin.pw, { ip: "203.0.114.2" });
  check("a POST with no Origin and no Referer is 403", missing.status === 403, `${missing.status} ${missing.text}`);

  // The same POST with the correct Origin succeeds.
  const good = await login(USERS.origin.username, USERS.origin.pw, { ip: "203.0.114.3", origin: expected });
  check("the same POST with the correct Origin succeeds", good.status === 200, `${good.status} ${good.text}`);

  // Referer is the documented fallback for the Origin header.
  const viaReferer = await login(USERS.origin.username, USERS.origin.pw, {
    ip: "203.0.114.4", referer: `${expected}/index.html`,
  });
  check("a correct Referer origin is accepted in place of Origin", viaReferer.status === 200,
    `${viaReferer.status} ${viaReferer.text}`);
}

async function runBodyLimit() {
  // A sign-in body well over MAX_AUTH_BODY_BYTES (default 8192). The identifier field is
  // capped at 200 characters by the handler, but the byte ceiling is enforced while
  // reading, before any field is inspected -- so this is refused as too large, not as an
  // invalid request.
  const huge = "A".repeat(20000);
  const r = await login(huge, "whatever", { ip: "203.0.115.1", origin: BASE });
  check("an oversized request body is refused with 413 before parsing", r.status === 413,
    `${r.status} ${r.text.slice(0, 120)}`);
}

/* ---------------------------------------------------------------------------- main */

async function main() {
  if (!BASE) {
    console.log("SKIPPED tests/integration/hardening.mjs (PROBE_BASE_URL not set)");
    return;
  }
  if (!APP_URL) {
    console.log("SKIPPED tests/integration/hardening.mjs (DATABASE_URL_APP not set)");
    return;
  }

  let client;
  try {
    client = new Client({ connectionString: APP_URL, application_name: "vkon-attendance-hardening-test" });
    await client.connect();
  } catch (e) {
    console.log(`SKIPPED tests/integration/hardening.mjs (cannot reach the app database: ${e.message})`);
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

  try {
    // Origin and body checks first: they never reach the rate buckets (the guard runs
    // before the limit is consulted, and an oversized body is refused before the guard),
    // so they cannot steal a window from the rate-limiting scenario that follows.
    await runOriginCheck();
    await runBodyLimit();
    await runRateLimiting();
  } finally {
    for (const u of Object.values(USERS)) {
      await client.query(
        `DELETE FROM sessions WHERE employee_id = (SELECT id FROM employees WHERE username = $1)`,
        [u.username],
      ).catch(() => {});
    }
    // Neutralise rather than delete: these accounts now have audit rows, and the
    // append-only trigger forbids the ON DELETE SET NULL that removing them would cause.
    await client.query(
      `UPDATE employees SET active = FALSE, password_hash = NULL, password_change_required = FALSE
        WHERE username IN ('zhlock','zhothr','zhfresh','zhorigin')`,
    ).catch(() => {});
    await client.end().catch(() => {});
  }
}

main().then(() => {
  const failed = checks.filter((c) => !c.passed);
  console.log(`\n=== tests/integration/hardening.mjs: ${checks.length - failed.length}/${checks.length} checks passed ===`);
  if (failed.length) {
    console.log(`>>> ${failed.length} FAILED: ${failed.map((f) => f.name).join(", ")}`);
    process.exit(1);
  }
}).catch((err) => {
  console.error("[hardening] ERROR:", err && err.stack ? err.stack : err);
  process.exit(1);
});
