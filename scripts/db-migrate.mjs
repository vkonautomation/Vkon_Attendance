/**
 * scripts/db-migrate.mjs -- apply db/migrations/*.sql, one transaction each.
 *
 * The bookkeeping table is `schema_migrations(name, checksum, applied_at)`. A name
 * alone would be enough to know what has run; the checksum is what makes a
 * half-written migration recoverable, because the honest failure mode of "edit the
 * SQL file that already ran" is a database whose schema no file in the repository
 * describes. Postgres has no schema diffing to fall back on, so this runner refuses
 * to guess and says so.
 *
 * Rules a migration file has to follow, both enforced rather than documented-and-
 * hoped:
 *   - it runs inside one transaction, so it either fully applies or does not exist.
 *     Anything that cannot run in a transaction (CREATE INDEX CONCURRENTLY, VACUUM)
 *     has to be applied by hand and recorded by hand.
 *   - only .sql files directly in the directory, applied in filename order.
 *     Zero-padded numeric prefixes are the convention: 0001_, 0002_.
 *
 * Usage:
 *   node scripts/db-migrate.mjs                     # apply everything pending
 *   node scripts/db-migrate.mjs --dry-run           # say what would run
 *   node scripts/db-migrate.mjs --dir tests/fixtures/migrations/good
 */

import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadEnvChain, REPO_ROOT } from "./lib/env.mjs";
import { releaseMigrationLock, takeMigrationLock, withOwnerClient } from "./lib/db-config.mjs";

loadEnvChain();

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const valueOf = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? resolve(argv[i + 1]) : fallback;
};

const MIGRATIONS_DIR = valueOf("dir", join(REPO_ROOT, "db", "migrations"));
const DRY_RUN = flag("dry-run");

function sha256(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function migrationFiles() {
  let entries;
  try {
    entries = readdirSync(MIGRATIONS_DIR, { withFileTypes: true });
  } catch (e) {
    console.error(`[migrate] cannot read ${MIGRATIONS_DIR}: ${e.message}`);
    process.exitCode = 1;
    return [];
  }
  return entries
    .filter((e) => e.isFile() && e.name.endsWith(".sql"))
    .map((e) => e.name)
    .sort();
}

const ENSURE_TABLE = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  name        text PRIMARY KEY,
  checksum    text NOT NULL,
  applied_at  timestamptz NOT NULL DEFAULT now()
)`;

async function main() {
  const files = migrationFiles();
  if (!files.length) {
    console.error(`[migrate] no .sql files in ${MIGRATIONS_DIR}`);
    process.exitCode = 1;
    return;
  }

  await withOwnerClient(async (client) => {
    // Taken before anything is read, so two processes cannot both decide that the
    // same migration is pending. pg_advisory_lock waits rather than failing, which
    // is the right behaviour for a deploy that races a cron entry.
    await takeMigrationLock(client);
    try {
      await client.query(ENSURE_TABLE);
      const applied = new Map(
        (await client.query("SELECT name, checksum FROM schema_migrations ORDER BY name"))
          .rows.map((r) => [r.name, r.checksum]),
      );

      let ran = 0;
      for (const name of files) {
        const sql = readFileSync(join(MIGRATIONS_DIR, name), "utf8");
        const checksum = sha256(sql);
        const prior = applied.get(name);

        if (prior !== undefined) {
          if (prior !== checksum) {
            throw new Error(
              `${name} has already been applied and its contents have changed ` +
              `(stored ${prior.slice(0, 12)}…, file ${checksum.slice(0, 12)}…). ` +
              `Write a new migration instead of editing history: the database you are ` +
              `looking at was built from the old version of this file.`,
            );
          }
          continue;
        }

        if (DRY_RUN) {
          console.log(`[migrate] would apply ${name}`);
          ran++;
          continue;
        }

        // One transaction per file, deliberately: a failure must leave the schema at
        // the last migration that fully worked, not half of this one. The ledger row
        // is written inside the same transaction, so "recorded" and "applied" cannot
        // ever disagree -- a crash between the two is the bug that makes a runner
        // unusable on a real deploy.
        await client.query("BEGIN");
        try {
          await client.query(sql);
          await client.query(
            "INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)",
            [name, checksum],
          );
          await client.query("COMMIT");
        } catch (err) {
          await client.query("ROLLBACK").catch(() => { /* connection already gone */ });
          err.message = `${name} failed and was rolled back: ${err.message}`;
          err.migration = name;
          throw err;
        }
        ran++;
        console.log(`[migrate] applied ${name}`);
      }

      const version = (await client.query(
        "SELECT COUNT(*)::int AS n, COALESCE(MAX(name), '(none)') AS last FROM schema_migrations",
      )).rows[0];
      console.log(`[migrate] ${ran === 0 ? "nothing pending" : `${ran} migration(s) ${DRY_RUN ? "pending" : "applied"}`}; ` +
                  `schema at ${version.n} record(s), last '${version.last}'`);
    } finally {
      await releaseMigrationLock(client).catch(() => { /* the session is ending anyway */ });
    }
  });
}

main().catch((e) => {
  console.error(`[migrate] ERROR: ${e.message}`);
  process.exit(1);
});
