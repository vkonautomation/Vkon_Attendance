/**
 * scripts/db-seed.mjs -- load db/seed/synthetic.sql. Development only.
 *
 * Two rules, and both are the reason this is a script rather than `psql -f`:
 *
 *   1. It refuses on a production database. The seed contains nothing real -- that is
 *      what the guard test is for -- but "nothing real" describes the file, not the
 *      database it is about to write into. The only thing that stops a seeded synthetic
 *      employee from becoming a payroll line is the refusal here.
 *   2. It runs in one transaction. A seed that stops halfway leaves reference data
 *      missing and a roster that cannot be explained, which is a worse state than an
 *      unseeded database because it looks finished.
 *
 * Idempotent: the SQL upserts reference data and inserts everything else under
 * ON CONFLICT DO NOTHING or a NOT EXISTS guard, so running it twice changes nothing the
 * second time. That is what makes it safe to put in a compose entrypoint.
 *
 * Admin bootstrap (M3). The synthetic SQL sets no password for anyone -- an account with
 * no hash cannot sign in, which is the only state that cannot become a default
 * credential. So the one live administrator is made here, in the same transaction, from
 * a freshly generated password printed once and forced to change on first sign-in. It is
 * insert-if-absent (a re-run leaves a real person's chosen password alone) and it is
 * development-only, because the production refusal above runs before this ever does. The
 * hash is generated at runtime, never committed: a bcrypt string sitting in a source
 * file is exactly what the public-repository guard fails a build over, and rightly so.
 *
 * Usage:
 *   node scripts/db-seed.mjs
 *   node scripts/db-seed.mjs --file db/seed/synthetic.sql
 */

import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, relative, resolve } from "node:path";
import { loadEnvChain, REPO_ROOT } from "./lib/env.mjs";
import { withOwnerClient } from "./lib/db-config.mjs";

const require = createRequire(import.meta.url);
const bcrypt = require("bcryptjs");

loadEnvChain();

const argv = process.argv.slice(2);
const valueOf = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? resolve(argv[i + 1]) : fallback;
};
const SEED_FILE = valueOf("file", join(REPO_ROOT, "db", "seed", "synthetic.sql"));

// The environment variable the portal's own container already uses, so there is one
// switch for "is this the box people's attendance lives on" rather than a second one
// that can disagree with the first.
const ENVIRONMENT = (process.env.VKON_ENV || "development").toLowerCase();

const COUNTED = [
  ["leave_kinds", "leave kinds"],
  ["settings", "settings"],
  ["holidays", "holidays"],
  ["employees", "employees"],
  ["records", "attendance days"],
  ["leaves", "leave requests"],
  ["wfh", "wfh requests"],
  ["regularisations", "regularisations"],
  ["lop_entries", "LOP entries"],
];

async function main() {
  if (ENVIRONMENT === "production") {
    throw new Error(
      "refusing to seed: VKON_ENV=production. A synthetic roster must never be written " +
      "into a database that holds real attendance. Load real data on the deploy host " +
      "through scripts/db-import.mjs (M11) instead.",
    );
  }

  const sql = readFileSync(SEED_FILE, "utf8");

  await withOwnerClient(async (client) => {
    await client.query("BEGIN");
    try {
      await client.query(sql);
      await bootstrapAdmin(client);
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => { /* connection already gone */ });
      err.message = `seed rolled back: ${err.message}`;
      throw err;
    }

    const counts = [];
    for (const [table, label] of COUNTED) {
      const n = (await client.query(`SELECT COUNT(*)::int AS n FROM ${table}`)).rows[0].n;
      counts.push(`${n} ${label}`);
    }
    console.log(`[seed] ${relative(REPO_ROOT, SEED_FILE)}: ${counts.join(", ")}`);
  });
}

/**
 * Create the first administrator, if there is not one yet.
 *
 * Runs inside the caller's transaction, so a seed that fails after this point does not
 * leave a half-written admin behind, and an admin that exists is never re-passworded by a
 * later `make dev`. The password is randomBytes base64url -- not a word, not a name, not
 * anything in the burned-secret list -- and is echoed exactly once, on the line that says
 * it is temporary.
 */
async function bootstrapAdmin(client) {
  const exists = await client.query("SELECT 1 FROM employees WHERE username = 'admin' LIMIT 1");
  if ((exists.rowCount ?? 0) > 0) {
    console.log("[seed:admin] administrator already present; password left untouched");
    return;
  }

  const password = randomBytes(18).toString("base64url");
  // The same SHA-256 -> base64 pre-hash lib/auth/hash.ts applies, so a hash written here
  // verifies there. bcrypt's own 72-byte truncation would otherwise be reachable.
  const preHash = createHash("sha256").update(password, "utf8").digest("base64");
  const cost = Number(process.env.BCRYPT_COST_FACTOR || 11);
  const hash = await bcrypt.hash(preHash, cost);

  // active so the account can sign in; role admin so it can authorise; password_change_required
  // so this generated password cannot quietly become the permanent one. No email: a
  // bootstrap is not a person with a mailbox, and the seeded-email domain rule would then
  // have to make an exception for an address that does not exist.
  await client.query(
    `INSERT INTO employees
       (employee_code, username, name, role, active, password_hash, password_changed_at,
        password_change_required, timezone)
     VALUES
       ('ADMIN', 'admin', 'Attendance Administrator', 'admin', TRUE, $1, now(), TRUE, 'Asia/Kolkata')`,
    [hash],
  );

  console.log("[seed:admin] created the first administrator (username: admin).");
  console.log(`[seed:admin] TEMPORARY password (sign in once, then it forces a change): ${password}`);
}

main().catch((e) => {
  console.error(`[seed] ERROR: ${e.message}`);
  process.exit(1);
});
