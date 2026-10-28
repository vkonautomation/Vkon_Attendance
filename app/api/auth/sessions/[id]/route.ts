/**
 * DELETE /api/auth/sessions/{id} -- sign one device out.
 *
 * The id is the session id from GET /api/auth/sessions, which is the person's own
 * session list; it is not an employee id and not a token. Revocation is scoped to
 * `employee_id` in the statement, so an id belonging to a colleague matches nothing and
 * answers 404. Answering 403 instead would confirm the id exists, which is a small piece
 * of information an attacker did not have to earn.
 *
 * Signing yourself out through this route is allowed -- it is the last device case -- so
 * the response says so and clears the cookie as well, because a browser holding a token
 * whose row is revoked will only learn on the next request.
 */

import type { NextRequest } from "next/server";
import { revokeSessionById } from "@/lib/auth/session";
import { clearSessionCookie } from "@/lib/auth/cookie";
import { recordAudit } from "@/lib/db/audit";
import { clientIp } from "@/lib/http/request";
import { errorResponse, notFound } from "@/lib/http/errors";
import { json } from "@/lib/http/json";
import { requireSession } from "@/lib/http/require-session";

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function DELETE(
  req: NextRequest,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const session = await requireSession(req, { gate: false });
    const { id } = await context.params;

    if (!UUID.test(id)) throw notFound("There is no such session for your account.");

    const revoked = await revokeSessionById(session.employeeId, id);
    if (!revoked) throw notFound("There is no such session for your account.");

    const signedOutSelf = id === session.sessionId;
    await recordAudit({
      actorEmployeeId: session.employeeId,
      action: signedOutSelf ? "auth.logout" : "auth.sessions.revoke_one",
      entityType: "employee",
      entityId: session.employeeCode,
      detail: { sessionId: id, signedOutSelf },
      ip: clientIp(req),
    });

    return json({ ok: true, revoked: 1, signedOutSelf }, {
      setCookie: signedOutSelf ? clearSessionCookie() : undefined,
    });
  } catch (err) {
    return errorResponse(err, "DELETE /api/auth/sessions/[id]");
  }
}
