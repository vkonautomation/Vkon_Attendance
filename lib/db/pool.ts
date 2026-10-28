/**
 * lib/db/pool.ts -- the one Postgres connection pool the server holds.
 *
 * It connects as the application role, never as the owner. That role has INSERT,
 * UPDATE, DELETE and SELECT on tables the owner created and no CREATE at all, so an
 * injection in a route handler can reach rows but cannot install a trigger that
 * quietly rewrites attendance history. scripts/db-setup.mjs creates it; migrations
 * run from the host checkout as the owner.
 *
 * The pool is a module singleton cached on globalThis. Next's dev server re-evaluates
 * route modules on every edit, and a fresh Pool each time means every hot reload
 * leaks up to `dbPoolMax` connections against a server whose app role is capped at
 * 20 -- the failure looks like "the database stopped answering after I saved a file".
 */

import { Pool, type PoolClient, type QueryResultRow } from "pg";
import { config } from "../config";

export interface DbConfig {
  connectionString: string;
  max: number;
  statementTimeoutMs: number;
}

/** Where the pool will connect, and why it refuses to guess. */
export function dbConfig(env: NodeJS.ProcessEnv = process.env): DbConfig {
  const connectionString = env.DATABASE_URL_APP || "";
  if (!connectionString) {
    throw new Error(
      "DATABASE_URL_APP is not set. The API connects as the application role and never as the " +
      "owner; run `npm run db:setup` and put the app-role URL in the environment. Note that " +
      ".next/standalone deliberately ships no .env file -- the container must be given this.",
    );
  }
  return { connectionString, max: config().dbPoolMax, statementTimeoutMs: config().dbStatementTimeoutMs };
}

declare global {
  // eslint-disable-next-line no-var
  var __vkonPool: { pool: Pool; key: string } | undefined;
}

function newPool(): Pool {
  const { connectionString, max, statementTimeoutMs } = dbConfig();
  const pool = new Pool({
    connectionString,
    max,
    // A request that cannot get a connection in 5s is failing anyway; waiting longer
    // just turns one slow query into a queue of timed-out HTTP requests.
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 30_000,
    keepAlive: true,
  });

  // Every connection this process makes says what it is, so `pg_stat_activity` on the
  // database host distinguishes the attendance API from a migration or a job without
  // anybody having to remember which port was which. set_config() rather than SET
  // because SET will not take a bound parameter, and this runs on every connection.
  pool.on("connect", (client) => {
    client
      .query("SELECT set_config('application_name', 'vkon-attendance-api', false), " +
             "set_config('statement_timeout', $1, false)", [String(Math.round(statementTimeoutMs))])
      // A connection that cannot set these is still usable; the failure is not worth
      // throwing away the connection for, but it is worth one line in the log.
      .catch((err: Error) => console.error("[db] connection settings failed:", err.message));
  });

  pool.on("error", (err) => {
    // An idle client erroring cannot be attributed to a request, so it goes to the
    // log. Left unhandled it takes the process down, which would end every other
    // in-flight request for an event nobody was waiting on.
    console.error("[db] idle client error:", err.message);
  });

  return pool;
}

export function pool(): Pool {
  const g = globalThis as typeof globalThis & { __vkonPool?: { pool: Pool; key: string } };
  const key = dbConfig().connectionString;
  if (!g.__vkonPool || g.__vkonPool.key !== key) {
    // Re-configured (a test pointing at a throwaway database): close the old one
    // instead of leaking its connections for the life of the process.
    if (g.__vkonPool) void g.__vkonPool.pool.end().catch(() => { /* going away */ });
    g.__vkonPool = { pool: newPool(), key };
  }
  return g.__vkonPool.pool;
}

export async function query<R extends QueryResultRow = QueryResultRow>(
  text: string,
  params: readonly unknown[] = [],
): Promise<R[]> {
  const res = await pool().query<R>(text, params as unknown[]);
  return res.rows;
}

/** The single row a write should produce, or null. */
export async function queryOne<R extends QueryResultRow = QueryResultRow>(
  text: string,
  params: readonly unknown[] = [],
): Promise<R | null> {
  const rows = await query<R>(text, params);
  return rows[0] ?? null;
}

/**
 * One transaction, with the caller's work inside it and a rollback if anything
 * throws. This is the only sanctioned way to write more than one row: the document
 * commands (D1) and the approval flow (M8) both have to write several tables or none,
 * and a half-applied approval is a leave that exists without the record it produced.
 *
 * `fn` receives a client already inside the transaction. It must not call `pool()`
 * for its own queries -- those would run outside the transaction.
 */
export async function withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool().connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    // The rollback itself can fail because the connection is gone or the transaction
    // was already aborted by the error; either way the original error is the one that
    // explains what happened, so this stays quiet.
    await client.query("ROLLBACK").catch(() => { /* transaction already aborted */ });
    throw err;
  } finally {
    client.release();
  }
}

/** Used by scripts and by the test suite; a server process never calls this. */
export async function closePool(): Promise<void> {
  const g = globalThis as typeof globalThis & { __vkonPool?: { pool: Pool; key: string } };
  if (g.__vkonPool) {
    await g.__vkonPool.pool.end();
    g.__vkonPool = undefined;
  }
}

/**
 * Postgres error codes worth naming, so a route handler maps a constraint to a status
 * instead of matching on an English message that a future release may reword.
 */
export const PG = {
  uniqueViolation: "23505",
  foreignKeyViolation: "23503",
  checkViolation: "23514",
  notNullViolation: "23502",
  tooManyConnections: "53300",
  queryCanceled: "57014",
  insufficientPrivilege: "42501",
} as const;

export function pgCode(err: unknown): string | null {
  if (err && typeof err === "object" && "code" in err && typeof err.code === "string") return err.code;
  return null;
}
