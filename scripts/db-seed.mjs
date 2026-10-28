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
 * Usage:
 *   node scripts/db-seed.mjs
 *   node scripts/db-seed.mjs --file db/seed/synthetic.sql
 */

import { readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { loadEnvChain, REPO_ROOT } from "./lib/env.mjs";
import { withOwnerClient } from "./lib/db-config.mjs";

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

main().catch((e) => {
  console.error(`[seed] ERROR: ${e.message}`);
  process.exit(1);
});
