/**
 * POST /api/auth/login -- prove a password, get a cookie.
 *
 * The response is the session object js/api.js keeps, and the error is one sentence for
 * every way a sign-in can fail. Both halves of that are contracts with the front end:
 * api.js branches on the status code (401 invalid, 429 throttled, anything else
 * unreachable) and shows `error.message` to a person, so a more helpful error that
 * distinguished "no such user" from "wrong password" would be a vulnerability it
 * displays verbatim.
 *
 * A session is created even for an account still holding its forced first password.
 * That is deliberate: the only thing such an account may do is change its password, and
 * changing it requires being signed in. `mustChangePassword` in the body is how the
 * browser knows to route to that form instead of hydrating state, and requireSession()
 * is what makes every other endpoint refuse.
 */

import type { NextRequest } from "next/server";
import { config } from "@/lib/config";
import { authenticate } from "@/lib/auth/authenticate";
import { clearSessionCookie, sessionCookie } from "@/lib/auth/cookie";
import { createSession } from "@/lib/auth/session";
import { checkRateLimit, recordFailure, recordSuccess, type RateKeys } from "@/lib/auth/ratelimit";
import { recordAudit } from "@/lib/db/audit";
import { clientIp, userAgent } from "@/lib/http/request";
import { badRequest, errorResponse, tooManyRequests } from "@/lib/http/errors";
import { assertSameOrigin } from "@/lib/http/guard";
import { expectObject, json, readJsonBody } from "@/lib/http/json";
import { sessionForBrowser } from "@/lib/http/require-session";

export const dynamic = "force-dynamic";

/** One message for four reasons: unknown name, wrong password, no password set, and a
 *  deactivated account. They are indistinguishable here by design. */
const INVALID = "That sign-in name and password do not match.";

/** Read the two fields without saying which one was wrong. */
function credentials(body: Record<string, unknown>): { identifier: string; password: string } {
  const identifier = typeof body.identifier === "string" ? body.identifier.trim() : "";
  const password = typeof body.password === "string" ? body.password : "";
  if (!identifier || !password || identifier.length > 200 || password.length > 400) {
    throw badRequest("That sign-in request is not complete.", "invalid_request");
  }
  return { identifier, password };
}

export async function POST(req: NextRequest): Promise<Response> {
  try {
    // Second CSRF lock (M4): a cross-origin or origin-less sign-in POST is refused
    // before a password is even looked at. No-op when PUBLIC_ORIGIN is unset.
    assertSameOrigin(req);

    const { identifier, password } = credentials(
      expectObject(await readJsonBody(req, config().maxBodyBytes.auth)),
    );

    const ip = clientIp(req);
    // The account bucket keys on the identifier as typed (normalised), so an attempt
    // against a name that does not exist still consumes it -- there is no cheaper way to
    // probe for accounts, and the address bucket is the one that stops a list being
    // worked at all. `ip` is null when the address cannot be honestly attributed, in
    // which case only the account limit applies (see lib/auth/ratelimit.ts).
    const keys: RateKeys = { account: identifier.toLowerCase(), ip };

    // Refused before the bcrypt comparison: a throttled flood must not pay hashing cost.
    const limit = checkRateLimit(keys);
    if (!limit.allowed) {
      throw tooManyRequests(
        "Too many sign-in attempts. Wait a moment before trying again.",
        limit.retryAfterSeconds,
      );
    }

    const result = await authenticate(identifier, password);

    if (!result.ok) {
      recordFailure(keys);
      // The reason stays server-side. An audit entry recording that somebody tried the
      // name of an account that does not exist is worth having; putting it in a 401 body
      // is what turns a login form into a staff directory.
      await recordAudit({
        action: "auth.login.failure",
        entityType: "employee",
        detail: { reason: result.reason, attempted: identifier.slice(0, 64) },
        ip,
      });
      // A cookie that has just failed to authorise is cleared on the way out, so the
      // browser stops sending a value that can only produce this same answer.
      return json({ error: { message: INVALID } }, {
        status: 401,
        setCookie: clearSessionCookie(),
      });
    }

    const account = result.account;
    recordSuccess(keys);
    const created = await createSession(account.id, { ip, userAgent: userAgent(req) });

    await recordAudit({
      actorEmployeeId: account.id,
      action: "auth.login.success",
      entityType: "employee",
      entityId: account.employeeCode,
      detail: { sessionId: created.sessionId, mustChangePassword: account.passwordChangeRequired },
      ip,
    });

    return json(sessionForBrowser({
      employeeCode: account.employeeCode,
      username: account.username,
      name: account.name,
      email: account.email,
      role: account.role,
      jobTitle: account.jobTitle,
      passwordChangeRequired: account.passwordChangeRequired,
      sessionId: created.sessionId,
      expiresAt: created.expiresAt.toISOString(),
    }), { setCookie: sessionCookie(created.token) });
  } catch (err) {
    return errorResponse(err, "POST /api/auth/login");
  }
}
