/**
 * lib/auth/authenticate.ts -- proving a password, without saying which part failed.
 *
 * The whole file exists for one property: an attacker with a list of identifiers and
 * one password must learn nothing from the response, including its timing. Three ways
 * that leaks usually happen, and what is done about each:
 *
 *   Text    "No account with that username" versus "wrong password" is a user list.
 *           There is one outcome and one message; the reason codes below never reach a
 *           client, only the audit log.
 *   Timing  A lookup miss that returns immediately is 200 ms of tell. So an unknown
 *           identity still costs one bcrypt comparison, against a hash of a value
 *           nobody knows (dummyHash) at the same cost factor a real account uses.
 *   Shape   An account with no password set would otherwise skip the comparison. It
 *           does not: the dummy is used there too.
 *
 * `identifier` is what the portal already accepts -- username, employee code or work
 * email, matched case-insensitively -- because the field on the login screen has not
 * changed and D1 says the front end is not rewritten to suit the backend.
 */

import { queryOne } from "../db/pool";
import { dummyHash, verifyPassword } from "./hash";

export interface Account {
  id: string;
  employeeCode: string;
  username: string;
  name: string;
  email: string | null;
  role: "employee" | "manager" | "admin";
  jobTitle: string | null;
  geofenceEnabled: boolean;
  active: boolean;
  passwordHash: string | null;
  passwordChangeRequired: boolean;
}

export type AuthFailureReason = "unknown_identity" | "bad_password" | "no_password_set" | "inactive";

export type AuthResult =
  | { ok: true; account: Account }
  | { ok: false; reason: AuthFailureReason };

interface AccountRow {
  id: string;
  employee_code: string;
  username: string;
  name: string;
  email: string | null;
  role: string;
  job_title: string | null;
  geofence_enabled: boolean;
  active: boolean;
  password_hash: string | null;
  password_change_required: boolean;
}

/**
 * Find the account an identifier refers to.
 *
 * The comparison is done on normalised values rather than by wrapping the columns in
 * lower(): `username` and `employee_code` already carry CHECK constraints that force
 * them to lower and upper case respectively (0002_core.sql), so the unique indexes on
 * them stay usable and the only column that needs a function applied is email, which
 * has no such constraint because the portal lets an administrator type one.
 */
export async function findAccount(identifier: string): Promise<Account | null> {
  const value = identifier.trim();
  if (!value) return null;
  const lower = value.toLowerCase();
  const upper = value.toUpperCase();

  const row = await queryOne<AccountRow>(
    `SELECT id, employee_code, username, name, email, role, job_title, geofence_enabled,
            active, password_hash, password_change_required
       FROM employees
      WHERE username = $1
         OR employee_code = $2
         OR (email IS NOT NULL AND lower(email) = $1)
      LIMIT 1`,
    [lower, upper],
  );
  if (!row) return null;

  return {
    id: row.id,
    employeeCode: row.employee_code,
    username: row.username,
    name: row.name,
    email: row.email,
    role: row.role as Account["role"],
    jobTitle: row.job_title,
    geofenceEnabled: row.geofence_enabled,
    active: row.active,
    passwordHash: row.password_hash,
    passwordChangeRequired: row.password_change_required,
  };
}

/**
 * Check a password against an account, at a constant cost whatever the answer is.
 *
 * Note the order: the comparison always happens, and only then is the account's state
 * considered. Short-circuiting on `!active` would make a deactivated account answer
 * faster than a wrong password, which is a way to find out who has left.
 */
export async function authenticate(identifier: string, password: string): Promise<AuthResult> {
  const account = await findAccount(identifier);
  const candidate = password ?? "";
  const stored = account?.passwordHash || null;

  const ok = await verifyPassword(candidate, stored ?? (await dummyHash()));

  if (!account) return { ok: false, reason: "unknown_identity" };
  if (!stored) return { ok: false, reason: "no_password_set" };
  if (!ok) return { ok: false, reason: "bad_password" };
  if (!account.active) return { ok: false, reason: "inactive" };

  return { ok: true, account };
}
