/**
 * lib/auth/session.ts -- the session table, and the decision every request makes.
 *
 * A session row is the whole authentication decision. Nothing about the identity is in
 * the cookie, so nothing in the cookie can be edited: role, employee id and name are
 * read from the database on every request, which is what makes deactivating someone
 * take effect on their next request rather than at their next sign-in -- and a person
 * who is signed in on a phone may never sign in again.
 *
 * Two deadlines, both checked here (the schema stores only one of them):
 *
 *   idle      expires_at, extended on activity. 12h by default (Q8).
 *   absolute  created_at + 36h, never extended. An unattended tab dies here even if
 *             something is polling it, which is the case the idle deadline alone
 *             cannot cover -- the portal pulls /api/state every 60 seconds by itself,
 *             so a logged-in laptop would otherwise extend its own session forever.
 *
 * The absolute deadline is derived rather than stored in a second column: two columns
 * that must agree are two columns that eventually will not.
 */

import { config } from "../config";
import { query, queryOne, withTransaction } from "../db/pool";
import { newToken, tokenHash } from "./token";

export type SessionStatus =
  | "ok"
  | "no_cookie"
  | "not_found"
  | "expired"
  | "revoked"
  | "inactive";

export interface AuthSession {
  /** sessions.id -- safe to show the person, it identifies their own device. */
  sessionId: string;
  /** employees.id (uuid). Never sent to the browser as `employeeId`. */
  employeeId: string;
  /** What the portal calls an employee id: "EMP001". js/api.js matches roster rows on it. */
  employeeCode: string;
  username: string;
  name: string;
  email: string | null;
  role: "employee" | "manager" | "admin";
  jobTitle: string | null;
  geofenceEnabled: boolean;
  passwordChangeRequired: boolean;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
}

interface SessionRow {
  session_id: string;
  employee_id: string;
  employee_code: string;
  username: string;
  name: string;
  email: string | null;
  role: string;
  job_title: string | null;
  geofence_enabled: boolean;
  password_change_required: boolean;
  active: boolean;
  created_at: Date;
  last_seen_at: Date;
  expires_at: Date;
  revoked_at: Date | null;
}

const SELECT = `
  SELECT s.id AS session_id, s.employee_id, s.created_at, s.last_seen_at, s.expires_at,
         s.revoked_at,
         e.employee_code, e.username, e.name, e.email, e.role, e.job_title,
         e.geofence_enabled, e.password_change_required, e.active
    FROM sessions s
    JOIN employees e ON e.id = s.employee_id
   WHERE s.token_hash = $1`;

/**
 * A new session for an employee who has just proved their password.
 *
 * `ip` and `user_agent` are recorded so /auth/sessions can tell a person which device
 * is signed in -- the answer to "was that me, or is someone else in my account" -- and
 * so a revoke-everything action has something to show for itself.
 */
export async function createSession(
  employeeId: string,
  meta: { ip?: string | null; userAgent?: string | null } = {},
): Promise<{ token: string; sessionId: string; expiresAt: Date }> {
  const token = newToken();
  const hash = tokenHash(token);
  const idleDeadline = new Date(Date.now() + config().sessionIdleMs);

  const row = await queryOne<{ id: string; expires_at: Date }>(
    `INSERT INTO sessions (employee_id, token_hash, expires_at, ip_cidr, user_agent)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, expires_at`,
    [employeeId, hash, idleDeadline, meta.ip ?? null, (meta.userAgent ?? "").slice(0, 400) || null],
  );
  if (!row) throw new Error("session insert returned no row");
  return { token, sessionId: row.id, expiresAt: row.expires_at };
}

/** The absolute deadline for a session created at `createdAt`. */
function absoluteDeadline(createdAt: Date): number {
  return createdAt.getTime() + config().sessionAbsoluteMs;
}

/** What the idle deadline would become after this request, capped by the absolute one. */
function nextIdleDeadline(row: SessionRow, now: number): number {
  return Math.min(now + config().sessionIdleMs, absoluteDeadline(row.created_at));
}

/**
 * Turn a cookie value into an identity, or say why it cannot be one.
 *
 * Every rejection path is a status rather than a thrown error, because the caller has
 * to answer three different situations with three different messages (no cookie, a
 * cookie that was never issued, a cookie that was once valid) and none of them is an
 * exception in the programming sense.
 */
export async function resolveSession(token: string | null): Promise<{ status: SessionStatus; session?: AuthSession }> {
  if (!token) return { status: "no_cookie" };
  const hash = tokenHash(token);

  const row = await queryOne<SessionRow>(SELECT, [hash]);
  if (!row) return { status: "not_found" };
  if (row.revoked_at) return { status: "revoked" };
  if (!row.active) return { status: "inactive" };

  const now = Date.now();
  if (row.expires_at.getTime() < now || absoluteDeadline(row.created_at) < now) {
    return { status: "expired" };
  }

  // Extend the idle deadline only when this request actually moves it on by more than
  // a minute. Without that floor every page poll in the portal (it pulls state once a
  // minute) is a write to the sessions table, and a write that changes nothing is pure
  // overhead on the smallest database in the fleet.
  const candidate = nextIdleDeadline(row, now);
  const extendsBy = candidate - row.expires_at.getTime();
  if (extendsBy > 60_000) {
    await query(
      `UPDATE sessions SET last_seen_at = now(), expires_at = $2
        WHERE id = $1 AND expires_at < $2`,
      [row.session_id, new Date(candidate)],
    );
  }

  return { status: "ok", session: toSession(row) };
}

function toSession(row: SessionRow): AuthSession {
  return {
    sessionId: row.session_id,
    employeeId: row.employee_id,
    employeeCode: row.employee_code,
    username: row.username,
    name: row.name,
    email: row.email,
    role: row.role as AuthSession["role"],
    jobTitle: row.job_title,
    geofenceEnabled: row.geofence_enabled,
    passwordChangeRequired: row.password_change_required,
    createdAt: row.created_at.toISOString(),
    lastSeenAt: row.last_seen_at.toISOString(),
    // The deadline this request just earned, not the one it arrived with, so a caller
    // that shows it is showing the truth about what happens next.
    expiresAt: new Date(nextIdleDeadline(row, Date.now())).toISOString(),
  };
}

/** Revoke the session a token belongs to. Idempotent: signing out twice is signing out. */
export async function revokeSessionByToken(token: string): Promise<boolean> {
  const row = await queryOne<{ id: string; revoked_at: Date | null }>(
    `UPDATE sessions
        SET revoked_at = COALESCE(revoked_at, now())
      WHERE token_hash = $1
      RETURNING id, revoked_at`,
    [tokenHash(token)],
  );
  return !!row;
}

/**
 * Revoke every live session an employee holds, optionally keeping one.
 *
 * This is what "change my password" means for the rest of the fleet: the laptop in the
 * office stays signed in because the person just proved they own it, and the phone that
 * was left somewhere else stops working on its next request. Done in one statement
 * because two statements would leave a window in which the kept session could be
 * revoked by a concurrent password change and the caller would not know.
 */
export async function revokeEmployeeSessions(employeeId: string, exceptSessionId?: string | null): Promise<number> {
  const rows = await query<{ id: string }>(
    `UPDATE sessions
        SET revoked_at = now()
      WHERE employee_id = $1
        AND revoked_at IS NULL
        AND ($2::uuid IS NULL OR id <> $2)
      RETURNING id`,
    [employeeId, exceptSessionId ?? null],
  );
  return rows.length;
}

export interface SessionSummary {
  sessionId: string;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  current: boolean;
  ip: string | null;
  userAgent: string | null;
}

/** The person's own live sessions, newest seen first, for /auth/sessions. */
export async function listEmployeeSessions(employeeId: string, currentSessionId: string): Promise<SessionSummary[]> {
  const rows = await query<{
    id: string; created_at: Date; last_seen_at: Date; expires_at: Date;
    ip_cidr: string | null; user_agent: string | null;
  }>(
    `SELECT id, created_at, last_seen_at, expires_at, ip_cidr, user_agent
       FROM sessions
      WHERE employee_id = $1 AND revoked_at IS NULL AND expires_at > now()
      ORDER BY last_seen_at DESC`,
    [employeeId],
  );
  return rows.map((r) => ({
    sessionId: r.id,
    createdAt: r.created_at.toISOString(),
    lastSeenAt: r.last_seen_at.toISOString(),
    expiresAt: r.expires_at.toISOString(),
    current: r.id === currentSessionId,
    ip: r.ip_cidr,
    userAgent: r.user_agent,
  }));
}

/**
 * Sign one device out by id, refusing to sign out a session that is not that
 * employee's. Returns false when nothing matched, which the route turns into a 404 --
 * never a 403, because "that session id belongs to someone else" is information.
 */
export async function revokeSessionById(employeeId: string, sessionId: string): Promise<boolean> {
  const row = await queryOne<{ id: string }>(
    `UPDATE sessions SET revoked_at = now()
      WHERE id = $1 AND employee_id = $2 AND revoked_at IS NULL
      RETURNING id`,
    [sessionId, employeeId],
  );
  return !!row;
}

/**
 * Drop sessions whose deadlines have passed. The worker calls this (M10); it is here so
 * the sweep shares the expiry arithmetic with the check instead of restating it.
 * Revoked rows are kept: they are the record of a session that ended, and the sessions
 * table is small.
 */
export async function sweepExpiredSessions(): Promise<number> {
  // The same arithmetic as resolveSession, computed here rather than in SQL: `now()`
  // on the database and Date.now() here are the same clock in practice (the container
  // and the database are both UTC), and one formula in one language is the version
  // that cannot drift from the check that rejects a session.
  const absoluteCutoff = new Date(Date.now() - config().sessionAbsoluteMs);
  return withTransaction(async (client) => {
    const res = await client.query(
      `UPDATE sessions SET revoked_at = now()
        WHERE revoked_at IS NULL
          AND (expires_at < now() OR created_at < $1)`,
      [absoluteCutoff],
    );
    return res.rowCount ?? 0;
  });
}
