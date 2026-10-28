/**
 * lib/auth/password.ts -- writing a password, and what follows from it.
 *
 * Changing a password is three effects in one transaction, and the transaction is the
 * point. Hash the new one and forget to revoke the others, and a stolen session keeps
 * working after the owner has done the one thing that was supposed to stop it. Revoke
 * first and crash before the hash lands, and the person is signed out everywhere
 * including where they are standing, with the old password still valid.
 *
 *   1. the new hash, with password_changed_at stamped for the audit trail;
 *   2. the forced-change flag cleared, if this was the first sign-in;
 *   3. every other live session for that employee revoked, the current one kept.
 *
 * The failed-attempt counter and the lock are reset here too: a person who has just
 * proved they know the password is not the person the counter was counting.
 */

import { withTransaction } from "../db/pool";
import { hashPassword } from "./hash";

/**
 * Install a new password for an account. `exceptSessionId` stays signed in; pass null
 * (an administrator resetting someone, a job, a script) and everything dies, which is
 * the safe direction for a password nobody in the room knows any more.
 *
 * Returns the number of other sessions revoked -- recorded in the audit entry, because
 * "I changed my password and four devices stopped working" is the answer to a question
 * somebody will ask.
 */
export async function setPassword(
  employeeId: string,
  newPassword: string,
  options: { exceptSessionId?: string | null; clearChangeRequired?: boolean } = {},
): Promise<{ sessionsRevoked: number }> {
  const hash = await hashPassword(newPassword);
  const clearFlag = options.clearChangeRequired !== false;
  const except = options.exceptSessionId ?? null;

  return withTransaction(async (client) => {
    await client.query(
      `UPDATE employees
          SET password_hash = $2,
              password_changed_at = now(),
              password_change_required = CASE WHEN $3 THEN false ELSE password_change_required END,
              failed_attempts = 0,
              locked_until = NULL
        WHERE id = $1`,
      [employeeId, hash, clearFlag],
    );

    const revoked = await client.query(
      `UPDATE sessions SET revoked_at = now()
        WHERE employee_id = $1
          AND revoked_at IS NULL
          AND ($2::uuid IS NULL OR id <> $2)`,
      [employeeId, except],
    );

    return { sessionsRevoked: revoked.rowCount ?? 0 };
  });
}
