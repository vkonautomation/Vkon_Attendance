/**
 * GET /api/auth/me -- "who am I, if anyone".
 *
 * This is the one endpoint that does not 401 when there is no session. boot() in
 * js/api.js calls it before the person has signed in, purely to find out whether a
 * server exists and whether the browser already holds a cookie that means something;
 * a 401 there would be an expected answer reported as an error, and it would put a
 * red line in every console on every cold load.
 *
 * So the shape is `{ signedIn: false }` for nobody and the session object for somebody.
 * A cookie that resolves to nothing -- revoked, expired, or an account that has been
 * deactivated -- also produces `{ signedIn: false }`, plus a Set-Cookie that clears it:
 * holding on to a value that can never work again is how a browser gets stuck on a
 * sign-in screen it cannot leave.
 */

import type { NextRequest } from "next/server";
import { clearSessionCookie } from "@/lib/auth/cookie";
import { errorResponse } from "@/lib/http/errors";
import { json } from "@/lib/http/json";
import { resolveActor, sessionForBrowser, sessionToken } from "@/lib/http/require-session";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<Response> {
  try {
    const hadToken = sessionToken(req) !== null;
    const { status, session } = await resolveActor(req);

    if (session) return json(sessionForBrowser(session));

    // The body does not say which of the four ways a cookie can stop working applied.
    // The front end has one answer -- show the sign-in screen -- and telling a holder
    // that their account was deactivated is a fact the login endpoint refuses to give
    // out, so giving it out here would be a door left open next door. The status is used
    // for the log line only.
    if (hadToken) console.info(`[auth] /me: session no longer valid (${status})`);
    return json({ signedIn: false }, {
      setCookie: hadToken ? clearSessionCookie() : undefined,
    });
  } catch (err) {
    return errorResponse(err, "GET /api/auth/me");
  }
}
