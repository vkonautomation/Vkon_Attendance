/**
 * POST /api/auth/logout -- end this session, on the server and in this browser.
 *
 * Two things have to happen and only one of them is the cookie. Deleting the browser's
 * copy leaves the row live, which means a token taken from a log, a backup, or a
 * borrowed laptop would still work after the person walked away. Setting revoked_at is
 * what actually ends it: requireSession() reads the row on every request, so the next
 * one from anywhere fails.
 *
 * Always 200. Signing out from a session that had already expired is not a failure --
 * the state the person wanted is the state they are in -- and js/api.js calls this from
 * a click that must clear the local cache whether or not the network agreed.
 */

import type { NextRequest } from "next/server";
import { clearSessionCookie } from "@/lib/auth/cookie";
import { revokeSessionByToken } from "@/lib/auth/session";
import { recordAudit } from "@/lib/db/audit";
import { clientIp } from "@/lib/http/request";
import { errorResponse } from "@/lib/http/errors";
import { json } from "@/lib/http/json";
import { resolveActor, sessionToken } from "@/lib/http/require-session";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest): Promise<Response> {
  try {
    const token = sessionToken(req);
    const { session } = await resolveActor(req);

    if (token) await revokeSessionByToken(token);

    if (session) {
      await recordAudit({
        actorEmployeeId: session.employeeId,
        action: "auth.logout",
        entityType: "employee",
        entityId: session.employeeCode,
        detail: { sessionId: session.sessionId },
        ip: clientIp(req),
      });
    }

    return json({ ok: true, signedIn: false }, { setCookie: clearSessionCookie() });
  } catch (err) {
    return errorResponse(err, "POST /api/auth/logout");
  }
}
