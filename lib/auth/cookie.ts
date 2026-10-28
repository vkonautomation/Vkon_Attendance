/**
 * lib/auth/cookie.ts -- the session cookie, attribute by attribute.
 *
 * Built as a string rather than through a framework helper so that the whole
 * security-relevant shape of the cookie is readable in one place and testable in
 * plain Node: there is no request object in these functions, and the unit test
 * asserts on the header itself.
 *
 * The attributes and why each one is here:
 *
 *   HttpOnly    no script can read it. The portal has no need to: everything a page
 *               shows comes from an authenticated fetch.
 *   SameSite=Lax  the cookie does not ride on a cross-site POST, which is the CSRF
 *               defence. The Origin check in M4 is the second lock, not the first.
 *   Secure      from config; production refuses to start with it off.
 *   Path=/      the API is one tree, and a narrower Path means a second cookie can
 *               be planted on a sibling path.
 *   no Domain   host-only by omission. A Domain of .vkon.in would hand the attendance
 *               session to anything else ever served from that apex domain, which is
 *               where the store lives.
 *   no Max-Age  a session cookie: closing the browser ends it locally. The real
 *               deadline is in the database (12h idle, 36h absolute), and a cookie
 *               that outlives its row is a 401 rather than a security property.
 */

import { config } from "../config";

/** The Set-Cookie header that establishes a session. */
export function sessionCookie(token: string, secure = config().cookieSecure): string {
  const parts = [`${config().cookieName}=${token}`, "Path=/", "HttpOnly", "SameSite=Lax"];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

/**
 * The Set-Cookie header that removes one. Max-Age=0 and a past Expires are both
 * written because that is the pair every client honours; the value is emptied, which
 * sessionTokenFrom() then rejects on shape, so a cookie that survived the delete can
 * never resolve to a row.
 */
export function clearSessionCookie(secure = config().cookieSecure): string {
  const parts = [
    `${config().cookieName}=`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    "Max-Age=0",
    "Expires=Thu, 01 Jan 1970 00:00:00 GMT",
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

/**
 * Read a cookie value out of a Cookie header. Route handlers get a parsed jar from
 * NextRequest, but every non-HTTP caller (a job, a test, a script) has only the
 * header, so this is the single parser and it is deliberately boring: split on ';',
 * exact name match, no decoding of anything.
 *
 * A cookie value containing a `;` would be a parse ambiguity; base64url tokens never
 * contain one, which is another reason the token is base64url.
 */
export function readCookie(headerValue: string | null | undefined, name: string): string | null {
  if (!headerValue) return null;
  for (const chunk of headerValue.split(";")) {
    const pair = chunk.trim();
    if (!pair) continue;
    const eq = pair.indexOf("=");
    if (eq < 0) continue;
    if (pair.slice(0, eq).trim() !== name) continue;
    const raw = pair.slice(eq + 1).trim();
    // A quoted cookie value is legal (RFC 6265 allows the wrapping quotes); strip
    // them rather than treating the quotes as part of the token.
    return raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"') ? raw.slice(1, -1) : raw;
  }
  return null;
}

/**
 * The session token from a request's Cookie header, or null. Shape-checked.
 */
export function sessionTokenFrom(headerValue: string | null | undefined): string | null {
  return normalizeSessionToken(readCookie(headerValue, config().cookieName));
}

/**
 * Accept a token only if it looks like one this server issued.
 *
 * 32 random bytes base64url is always 43 characters from this alphabet, so anything
 * else was not written here. Checking the shape before the database lookup costs
 * nothing and means a probe with an arbitrary cookie value never becomes a query --
 * which also keeps a malformed cookie from being distinguishable from an unknown one
 * by timing.
 */
export function normalizeSessionToken(value: string | null | undefined): string | null {
  if (!value) return null;
  return /^[A-Za-z0-9_-]{43}$/.test(value) ? value : null;
}
