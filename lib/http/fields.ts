/**
 * lib/http/fields.ts -- the small validated readers a JSON body is turned into.
 *
 * json.ts owns the required/optional *string* rules; this owns the shapes just past them:
 * a boolean that refuses a non-boolean rather than quietly reading it as `false`, a number
 * that must be finite, an ISO date checked by shape before Postgres is asked to parse it, and
 * a value from a fixed set. Each returns a typed result or throws `badRequest` naming the one
 * field at fault -- so a handler reads like a list of the fields it accepts, and a malformed
 * body fails on the field a person can actually correct.
 *
 * They live here because two endpoints (the roster's POST and PATCH) need the same readings,
 * and a validation rule that is copy-pasted is a rule that diverges the first time one copy is
 * fixed and the other is not.
 */

import { badRequest } from "./errors";

/** An optional boolean, or `fallback` when the key is absent/empty. A wrong type is a 400. */
export function boolField(obj: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const raw = obj[key];
  if (raw === undefined || raw === null || raw === "") return fallback;
  if (typeof raw === "boolean") return raw;
  if (raw === "true" || raw === 1 || raw === "1") return true;
  if (raw === "false" || raw === 0 || raw === "0") return false;
  throw badRequest(`\`${key}\` must be true or false.`, "invalid_field");
}

/** An optional finite number, or null when absent/empty. */
export function numOrNullField(obj: Record<string, unknown>, key: string): number | null {
  const raw = obj[key];
  if (raw === undefined || raw === null || raw === "") return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw badRequest(`\`${key}\` must be a number.`, "invalid_field");
  return n;
}

/** An ISO calendar date (YYYY-MM-DD) string, or null. Shape only; the range is the database's. */
export function isoDateField(obj: Record<string, unknown>, key: string): string | null {
  const raw = obj[key];
  if (raw === undefined || raw === null || raw === "") return null;
  if (typeof raw !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    throw badRequest(`\`${key}\` must be a date (YYYY-MM-DD).`, "invalid_date");
  }
  return raw;
}

/**
 * A value that must be one of `allowed`. Absent/empty yields `fallback` when one is given;
 * with no fallback (a PATCH that named the field) an empty value is refused rather than
 * silently defaulted, because "I asked to change your role and got the old one back" is a
 * worse answer than a clear 400.
 */
export function enumField<T extends string>(
  obj: Record<string, unknown>,
  key: string,
  allowed: readonly T[],
  fallback?: T,
): T {
  const raw = obj[key];
  if (raw === undefined || raw === null || raw === "") {
    if (fallback !== undefined) return fallback;
    throw badRequest(`\`${key}\` is required.`, "missing_field");
  }
  if (typeof raw !== "string" || !allowed.includes(raw as T)) {
    throw badRequest(`\`${key}\` must be one of ${allowed.join(", ")}.`, "invalid_field");
  }
  return raw as T;
}
