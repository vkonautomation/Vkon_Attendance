/**
 * scripts/lib/db-config.mjs -- the three things every database script needs.
 *
 * Kept in one place because a migration runner and a setup script that disagree
 * about which URL or which role they are talking to produce exactly the kind of
 * bug nobody sees: the runner applies as owner, the app cannot read the table,
 * and the portal 500s on the first punch of the month.
 */

import { Client } from "pg";

/**
 * The role that owns the schema and runs migrations. Never the one the application
 * connects as: the app role has no CREATE, so a compromised API cannot add a table
 * or a trigger that quietly rewrites history.
 */
export function ownerUrl(env = process.env) {
  const url = env.DATABASE_URL_OWNER || env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "DATABASE_URL_OWNER is not set. Export it (or DATABASE_URL) before running a database script.",
    );
  }
  return url;
}

/** The application role, created by scripts/db-setup.mjs. */
export function appUrl(env = process.env) {
  const url = env.DATABASE_URL_APP;
  if (!url) {
    throw new Error(
      "DATABASE_URL_APP is not set. Run `npm run db:setup` first, then point this at the attendance_app role.",
    );
  }
  return url;
}

export function appName(base) {
  return `vkon-attendance-${base}`;
}

/**
 * Connect, run, always disconnect. A script that leaves a connection behind holds
 * one of a very small max_connections pool against a database that a long-running
 * API also wants.
 */
export async function withOwnerClient(fn, env = process.env) {
  const client = new Client({ connectionString: ownerUrl(env), application_name: appName("owner") });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

/**
 * A lock around anything that must not run twice at once. Two migration processes
 * interleaving is not a theoretical problem: each would read schema_migrations
 * before the other had written it, and both would try to apply the same file.
 */
export const MIGRATION_LOCK_KEY = 72726601;

export async function takeMigrationLock(client) {
  await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_KEY]);
}

export async function releaseMigrationLock(client) {
  await client.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK_KEY]);
}
