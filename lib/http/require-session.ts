/**
 * lib/http/require-session.ts -- the one gate every authenticated route passes through.
 *
 * It reads the cookie, joins sessions to employees, and decides. Three things follow
 * from that shape and are the reason it is a function rather than a few lines in each
 * handler:
 *
 *   1. Identity comes from the database on every request. A deactivated employee is
 *      dropped on their next request, not at their next sign-in -- and a person signed
 *      in on a phone may never sign in again, so "at next sign-in" would mean "never".
 *   2. The idle deadline is extended here, so any authenticated call keeps a session
 *      alive; there is no separate heartbeat endpoint to forget to call.
 *   3. There is exactly one place a future route can fail to check, and it is this one.
 *
 * Role checks come from the same row: `session.role` is read from `employees`, never
 * from anything the client sent. The first route that needs to restrict by role is
 * the roster in M7, and it will take it from here rather than from a second source.
 */

import { config } from "../config";
import { normalizeSessionToken } from "../auth/cookie";
import { resolveSession, type AuthSession, type SessionStatus } from "../auth/session";
import { passwordChangeRequired, unauthorized } from "./errors";

/** A request, as far as session resolution needs: headers, and Next's cookie jar. */
export interface SessionRequest {
  headers: Headers;
  cookies?: { get(name: string): { value?: string } | undefined };
  ip?: string;
}

export function sessionToken(req: SessionRequest): string | null {
  const fromJar = req.cookies?.get(config().cookieName)?.value ?? null;
  if (fromJar) return normalizeSessionToken(fromJar);
  return normalizeSessionToken(req.headers.get("cookie"));
}

export interface ResolvedActor {
  status: SessionStatus;
  session: AuthSession | null;
}

/** The non-throwing form, for the one endpoint that reports the state instead of
 *  demanding it: GET /api/auth/me answers `{ signedIn: false }` to an anonymous
 *  browser, because the login screen has to know a server exists. */
export async function resolveActor(req: SessionRequest): Promise<ResolvedActor> {
  const result = await resolveSession(sessionToken(req));
  return result.status === "ok" && result.session
    ? { status: result.status, session: result.session }
    : { status: result.status, session: null };
}

export interface RequireSessionOptions {
  /**
   * Enforce the forced-password-change gate. True by default: an account still holding
   * its one-time password may read nothing about itself beyond the fact that it must
   * change it, which is what makes a generated first password a temporary one.
   *
   * The auth endpoints pass false, because they are the ones that let the person out of
   * that state.
   */
  gate?: boolean;
}

/**
 * The session, or an ApiError that says why there is not one.
 *
 * The messages are chosen for the person reading them on a phone. None of them names
 * an account, and none distinguishes "that session id is not in the table" from "it is
 * there but expired" in a way that helps an attacker: both are a cookie the holder was
 * given, and a cookie that was never issued is a 401 with the same sentence.
 */
export async function requireSession(
  req: SessionRequest,
  options: RequireSessionOptions = {},
): Promise<AuthSession> {
  const { status, session } = await resolveActor(req);

  if (!session) {
    const message =
      status === "no_cookie"
        ? "Sign in to continue."
        : status === "inactive"
          ? "That account is no longer active. Speak to an administrator."
          : "Your sign-in has ended. Sign in again to continue.";
    throw unauthorized(message);
  }

  if (options.gate !== false && session.passwordChangeRequired) {
    throw passwordChangeRequired();
  }

  return session;
}

/**
 * The session object as the browser sees it.
 *
 * `employeeId` is the portal's own key -- "EMP001", the value a roster row carries in
 * `id` -- because shared.js does `roster.find(e => String(e.id) === String(empId))` and
 * rewriting the 22k-line front end to know about uuids is not this project's scope (D1).
 * The uuid never leaves the server.
 *
 * The input is a structural subset so the sign-in route, which has just assembled the
 * account and the new session, can produce the same body without re-reading itself back
 * out of the database -- one field list, whichever path built it.
 */
export interface BrowserSessionView {
  employeeCode: string;
  username: string;
  name: string;
  email: string | null;
  role: AuthSession["role"];
  jobTitle: string | null;
  passwordChangeRequired: boolean;
  sessionId: string;
  expiresAt: string;
}

export function sessionForBrowser(session: BrowserSessionView): Record<string, unknown> {
  return {
    signedIn: true,
    employeeId: session.employeeCode,
    username: session.username,
    name: session.name,
    email: session.email,
    role: session.role,
    jobTitle: session.jobTitle,
    mustChangePassword: session.passwordChangeRequired,
    sessionId: session.sessionId,
    expiresAt: session.expiresAt,
  };
}
