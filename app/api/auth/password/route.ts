/**
 * POST /api/auth/password -- choose a new password for the signed-in account.
 *
 * js/api.js calls this from the change dialog and shows `error.message` straight to the
 * person, so these messages are written for them: each names what to do differently and
 * none repeats the password, names another account, or explains the policy in terms an
 * attacker could use.
 *
 * Two doors in, and the difference is the forced first sign-in:
 *
 *   currentPassword supplied   it is verified, always. This is the ordinary case of a
 *                              person changing their own password.
 *   currentPassword omitted    only accepted while the account still carries
 *                              `password_change_required`. The verified sign-in is the
 *                              proof in that flow -- the person knows the one-time
 *                              password the administrator generated, which is the thing
 *                              the current-password field would otherwise have asked for
 *                              a second time. js/api.js documents that omission as the
 *                              forced-change case, and an empty string used to be
 *                              rejected as a schema error before the handler ever ran.
 *
 * Everything else about the change is in lib/auth/password.ts: one transaction that
 * writes the hash, clears the flag and revokes every other session.
 */

import type { NextRequest } from "next/server";
import { config } from "@/lib/config";
import { findAccount } from "@/lib/auth/authenticate";
import { checkPasswordPolicy, verifyPassword } from "@/lib/auth/hash";
import { setPassword } from "@/lib/auth/password";
import { recordAudit } from "@/lib/db/audit";
import { clientIp } from "@/lib/http/request";
import { errorResponse } from "@/lib/http/errors";
import { expectObject, json, readJsonBody } from "@/lib/http/json";
import { requireSession } from "@/lib/http/require-session";

export const dynamic = "force-dynamic";

/** A failure in the shape js/api.js reads: body.error.message goes on screen. */
const reject = (message: string, reason: string, status = 400) =>
  json({ error: { message, reason } }, { status });

export async function POST(req: NextRequest): Promise<Response> {
  try {
    // gate: false -- this is the endpoint you reach *because* the gate is shut.
    const session = await requireSession(req, { gate: false });
    const body = expectObject(await readJsonBody(req, config().maxBodyBytes.auth));

    const newPassword = typeof body.newPassword === "string" ? body.newPassword : "";
    const currentPassword =
      typeof body.currentPassword === "string" && body.currentPassword !== "" ? body.currentPassword : null;

    if (!newPassword) return reject("Enter the new password you want to use.", "missing_password");

    // Load the account as it is now, not as the session remembered it: an administrator
    // may have reset this password, or flagged it for change, since this cookie was
    // issued, and the answer to "may I set a password without proving the old one"
    // depends on the state that is true at this moment.
    const account = await findAccount(session.employeeCode);
    if (!account) return reject("Sign in again to continue.", "session_expired", 401);

    const forced = account.passwordChangeRequired;

    if (currentPassword !== null) {
      if (!(await verifyPassword(currentPassword, account.passwordHash))) {
        return reject("That is not your current password.", "current_password_incorrect", 403);
      }
    } else if (account.passwordHash && !forced) {
      // The forced case is the only one that may skip the old password, and only while
      // the flag is up. Once a person has chosen their own password, changing it proves
      // it.
      return reject("Enter your current password before choosing a new one.",
        "current_password_required", 403);
    }

    const problem = checkPasswordPolicy(newPassword, {
      username: account.username,
      employeeCode: account.employeeCode,
    });
    if (problem) return reject(problem.message, problem.code);

    if (account.passwordHash && await verifyPassword(newPassword, account.passwordHash)) {
      return reject("That is the password you already use. Choose a different one.", "unchanged");
    }

    const { sessionsRevoked } = await setPassword(account.id, newPassword, {
      exceptSessionId: session.sessionId,
      clearChangeRequired: true,
    });

    await recordAudit({
      actorEmployeeId: account.id,
      action: "auth.password.change",
      entityType: "employee",
      entityId: account.employeeCode,
      // No trace of either password. `forced` is the useful fact: it says whether this
      // was the first-login change or a person rotating a password they had chosen.
      detail: { forced, sessionsRevoked },
      ip: clientIp(req),
    });

    return json({ ok: true, signedIn: true, sessionsRevoked });
  } catch (err) {
    return errorResponse(err, "POST /api/auth/password");
  }
}
