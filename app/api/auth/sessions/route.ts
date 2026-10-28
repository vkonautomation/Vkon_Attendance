/**
 * /api/auth/sessions -- the devices this account is signed in on.
 *
 * The reason this endpoint exists is the question it answers: "is someone else in my
 * account, and how do I get them out". Listing the live sessions with the address and
 * user agent that created them makes that answerable by the person rather than by an
 * administrator with a database, and "sign out of everything except this one" is the
 * action that follows -- which is the same operation a password change performs by
 * itself, offered here for the person who wants the devices gone but the password kept.
 *
 * A session is only ever listed and revoked for the employee it belongs to: the lookup
 * in revokeSessionById() carries employee_id in the WHERE clause, so asking for someone
 * else's session id revokes nothing and is answered with a 404 rather than a 403. The
 * difference matters: a 403 would confirm that the id exists.
 */

import type { NextRequest } from "next/server";
import { listEmployeeSessions, revokeEmployeeSessions } from "@/lib/auth/session";
import { recordAudit } from "@/lib/db/audit";
import { clientIp } from "@/lib/http/request";
import { errorResponse } from "@/lib/http/errors";
import { json } from "@/lib/http/json";
import { requireSession } from "@/lib/http/require-session";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<Response> {
  try {
    const session = await requireSession(req, { gate: false });
    const sessions = await listEmployeeSessions(session.employeeId, session.sessionId);
    // `current` is marked server-side from the cookie, not inferred from a field the
    // browser could pick, so the row the person is standing at cannot be disguised as
    // another device.
    return json({ sessions, count: sessions.length });
  } catch (err) {
    return errorResponse(err, "GET /api/auth/sessions");
  }
}

/**
 * Revoke every session but this one. The caller stays signed in; every other device
 * fails its next request. There is no body and no argument to get wrong.
 */
export async function DELETE(req: NextRequest): Promise<Response> {
  try {
    const session = await requireSession(req, { gate: false });
    const revoked = await revokeEmployeeSessions(session.employeeId, session.sessionId);

    await recordAudit({
      actorEmployeeId: session.employeeId,
      action: "auth.sessions.revoke_others",
      entityType: "employee",
      entityId: session.employeeCode,
      detail: { revoked, keptSessionId: session.sessionId },
      ip: clientIp(req),
    });

    return json({ ok: true, revoked });
  } catch (err) {
    return errorResponse(err, "DELETE /api/auth/sessions");
  }
}
