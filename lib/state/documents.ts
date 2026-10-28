/**
 * lib/state/documents.ts -- the read/write core of the /api/state document facade (D1).
 *
 * js/api.js turns the browser's synchronous localStorage stores into two HTTP calls:
 *
 *   GET  /api/state         -> { stores: { key: { value, version } }, serverVersion }
 *   PUT  /api/state/{key}   <- { baseVersion, value }  -> { version }, or 409 / 403 / 401
 *
 * This module owns the server's half of that contract: reading every shared document plus
 * the write counter, and applying one optimistic-concurrency write inside a transaction.
 *
 * Two rules that are the whole point of putting this here rather than in the route:
 *
 *   1. WHO may change WHICH store is decided on the server, from the session role, never
 *      trusted from the client. Each `vkon_*` key is classified `admin`, `any`, or `never`.
 *      Unknown keys fail closed to `admin`: an unclassified shared store is treated as
 *      privileged until somebody says otherwise, because guessing "probably safe for anyone"
 *      is how a policy store gets edited by the people it governs.
 *   2. A write is atomic across three things -- the document row, the revision counter, and
 *      (best-effort) the audit entry. withTransaction() is the only sanctioned way to touch
 *      more than one row, and this is the case its comment names ("the document commands").
 */

import { query, queryOne, withTransaction } from "../db/pool";
import { ApiError, forbidden, badRequest } from "../http/errors";
import { recordAudit } from "../db/audit";

/** The stores js/api.js refuses to send because they are per-device, not shared. */
const LOCAL_ONLY = new Set([
  "vkon_session_v6",
  "vkon_theme_v6",
  "vkon_regalert_seen_v1",
]);
/** The browser's offline punch queue -- drained via /api/punches, never PUT as a document. */
const QUEUE_KEY = "vkon_punch_queue_v1";

export type DocumentWriteClass = "admin" | "any" | "never";

/** Credentials never round-trip through a browser-writable facade (read-suppressed too). */
const NEVER_WRITABLE = new Set(["vkon_admin_creds_v6"]);

/** Configuration and policy: only an administrator may publish a new version. */
const ADMIN_ONLY = new Set([
  "vkon_settings_v6",
  "vkon_employees_v6",
  "vkon_holidays_v6",
  "vkon_leave_quotas_v6",
  "vkon_min_work_policy_v6",
  "vkon_admin_decision_snap_v6",
  "vkon_lop_entries_v1",
  "vkon_approval_flow_v1",
  "vkon_short_leave_settings_v1",
  "vkon_holiday_work_v1",
]);

/** Self-service submissions: any signed-in account may write its own copy forward. */
const ANY_AUTHENTICATED = new Set([
  "vkon_records_v6",
  "vkon_wfh_v6",
  "vkon_leaves_v6",
  "vkon_regularisations_v6",
  "vkon_notifications_v6",
  "vkon_tasks_v1",
]);

/**
 * A key the browser is allowed to treat as a shared document at all: prefixed, not a
 * per-device store, not the punch queue. The route rejects anything else with a 400 so a
 * stray key never reaches the classification (and never silently fails closed as "admin").
 */
export function isSharedDocumentKey(key: string): boolean {
  return /^vkon_[a-z0-9_]+$/.test(key) && !LOCAL_ONLY.has(key) && key !== QUEUE_KEY;
}

/** Who may write this key. Unknown-but-valid keys fail closed to `admin`. */
export function classifyDocument(key: string): DocumentWriteClass {
  if (NEVER_WRITABLE.has(key) || LOCAL_ONLY.has(key) || key === QUEUE_KEY) return "never";
  if (ADMIN_ONLY.has(key)) return "admin";
  if (ANY_AUTHENTICATED.has(key)) return "any";
  return "admin";
}

export interface StateProjection {
  stores: Record<string, { value: unknown; version: number }>;
  serverVersion: number;
}

/**
 * Everything a signed-in tab hydrates on boot and re-reads on pull(). `never`-class keys
 * are omitted: the server does not round-trip the admin credential store through a browser,
 * so it is neither published nor leaked here. The tab keeps its local copy and any PUT for
 * it is refused -- which is the intended deferral, not a lost store.
 */
export async function readStateDocuments(): Promise<StateProjection> {
  const rows = await query<{ key: string; value: unknown; version: string | number }>(
    "SELECT key, value, version FROM state_documents ORDER BY key",
  );
  const stores: StateProjection["stores"] = {};
  for (const r of rows) {
    if (classifyDocument(r.key) === "never") continue;
    stores[r.key] = { value: r.value, version: Number(r.version) };
  }
  return { stores, serverVersion: await getServerRevision() };
}

/** The monotonic write counter the browser compares in pull(). */
export async function getServerRevision(): Promise<number> {
  const row = await queryOne<{ revision: string | number }>(
    "SELECT revision FROM state_meta WHERE id = 1",
  );
  return row ? Number(row.revision) : 0;
}

export interface PutDocumentInput {
  key: string;
  value: unknown;
  baseVersion: number;
  role: "employee" | "manager" | "admin";
  actorEmployeeId: string | null;
  ip?: string | null;
}

/**
 * Apply one document write, returning the new per-key version.
 *
 * The concurrency contract: the caller sends the `version` it last read as `baseVersion`.
 * If that is not what the row currently holds, somebody else won the race and this throws a
 * 409 carrying the server's `currentValue`/`currentVersion` -- enough for the tab to adopt
 * theirs and tell the person, exactly as js/api.js `flush()` expects. A brand-new key must
 * arrive with baseVersion 0; a non-zero base for a missing row is also a 409 (the row was
 * created out from under us), never an insert.
 */
export async function putDocument(input: PutDocumentInput): Promise<number> {
  if (!isSharedDocumentKey(input.key)) {
    throw badRequest("That is not a shared document key.", "invalid_key");
  }

  const writeClass = classifyDocument(input.key);
  if (writeClass === "never") {
    throw forbidden("That store is not editable through the portal.", "document_not_writable");
  }
  if (writeClass === "admin" && input.role !== "admin") {
    throw forbidden("Only an administrator may change that.", "not_permitted");
  }

  if (!Number.isInteger(input.baseVersion) || input.baseVersion < 0) {
    throw badRequest("`baseVersion` must be a non-negative integer.", "invalid_base_version");
  }

  const newVersion = await withTransaction(async (client) => {
    const existing = await client.query<{ version: string | number; value: unknown }>(
      "SELECT version, value FROM state_documents WHERE key = $1 FOR UPDATE",
      [input.key],
    );

    if (existing.rows.length > 0) {
      const currentVersion = Number(existing.rows[0].version);
      if (input.baseVersion !== currentVersion) {
        throw conflict(existing.rows[0].value, currentVersion);
      }
      const next = currentVersion + 1;
      await client.query(
        `UPDATE state_documents
            SET value = $2::jsonb, version = $3, updated_by = $4, updated_at = now()
          WHERE key = $1`,
        [input.key, JSON.stringify(input.value), next, input.actorEmployeeId],
      );
      await bumpRevision(client);
      return next;
    }

    // No row yet: only a fresh key (baseVersion 0) may create it.
    if (input.baseVersion !== 0) {
      throw conflict(null, 0);
    }
    const inserted = await client.query(
      `INSERT INTO state_documents (key, value, version, updated_by)
       VALUES ($1, $2::jsonb, 1, $3)
       ON CONFLICT (key) DO NOTHING
       RETURNING version`,
      [input.key, JSON.stringify(input.value), input.actorEmployeeId],
    );
    if (inserted.rows.length === 0) {
      // Lost the create race to a concurrent writer of the same brand-new key: re-read and
      // report the winner's version rather than overwriting it.
      const winner = await client.query<{ version: string | number; value: unknown }>(
        "SELECT version, value FROM state_documents WHERE key = $1",
        [input.key],
      );
      const w = winner.rows[0];
      throw conflict(w ? w.value : null, w ? Number(w.version) : 0);
    }
    await bumpRevision(client);
    return 1;
  });

  // Audited only once the write has committed: the document itself is not recorded (it is
  // in the table), only that a version of a named store was published and by whom.
  await recordAudit({
    actorEmployeeId: input.actorEmployeeId,
    action: "state.document.put",
    entityType: "state_document",
    entityId: input.key,
    detail: { version: newVersion },
    ip: input.ip ?? null,
  });

  return newVersion;
}

async function bumpRevision(client: { query: (t: string, p?: readonly unknown[]) => Promise<unknown> }): Promise<void> {
  await client.query("UPDATE state_meta SET revision = revision + 1, updated_at = now() WHERE id = 1");
}

function conflict(currentValue: unknown, currentVersion: number): ApiError {
  return new ApiError(
    409,
    "That store changed on the server while you were editing. Their version was kept.",
    { reason: "version_conflict", extra: { currentValue, currentVersion } },
  );
}
