/**
 * lib/db/audit.ts -- the one place that writes to audit_log.
 *
 * audit_log is append-only (0005_audit.sql): privileges refuse an UPDATE and a
 * trigger refuses it even for the owner, so the only legal statement here is an
 * INSERT. That is why this module takes no `id` and offers no update or delete: there
 * is nothing to correct, only something to record.
 *
 * Two rules the callers depend on:
 *
 *   1. Nothing secret goes in `detail`. The type is `jsonb` because Postgres does not
 *      know what a password is, so the discipline is here: no password, no token, no
 *      coordinate, no photo. The auth events below record *that* something happened
 *      and which account it happened to, never what was typed.
 *   2. A failed audit write does not fail the request. The alternative -- refusing a
 *      sign-in because an INSERT could not be made -- turns an audit outage into an
 *      attendance outage, and on a host nobody is watching, people simply cannot clock
 *      in. The failure is logged loudly instead, and the gap is visible in the log.
 */

import { query } from "./pool";

export interface AuditEvent {
  /** The authenticated employee, when there is one. A failed sign-in has none. */
  actorEmployeeId?: string | null;
  /** lower-case dotted name: `auth.login.success`, `auth.password.change`. */
  action: string;
  entityType?: string | null;
  entityId?: string | null;
  detail?: Record<string, unknown> | null;
  ip?: string | null;
}

/**
 * Insert one entry. Awaited by callers, because a fire-and-forget promise inside a
 * serverless-style route handler can be reaped before the statement runs and the
 * entry silently never exists.
 */
export async function recordAudit(event: AuditEvent): Promise<boolean> {
  try {
    await query(
      `INSERT INTO audit_log (actor_employee_id, action, entity_type, entity_id, detail, ip)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6)`,
      [
        event.actorEmployeeId ?? null,
        event.action,
        event.entityType ?? null,
        event.entityId ?? null,
        event.detail ? JSON.stringify(event.detail) : null,
        event.ip ?? null,
      ],
    );
    return true;
  } catch (err) {
    console.error("[audit] WRITE FAILED", event.action, (err as Error).message);
    return false;
  }
}
