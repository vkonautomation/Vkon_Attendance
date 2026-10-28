/**
 * lib/auth/token.ts -- the cookie value and the row that vouches for it.
 *
 * The token is 32 random bytes, base64url: 43 characters drawn from
 * crypto.randomBytes, not from anything derived from the account or the clock. The
 * database stores only SHA-256 of it. So a read of the sessions table hands an
 * attacker nothing they can put in a cookie -- the value that would be replayed was
 * never written down anywhere -- and a leak of the hash is still not a session.
 *
 * base64url rather than hex or raw base64 because it is URL- and header-safe with no
 * escaping: `+` and `/` in a cookie value are legal but are the characters that get
 * mangled by every intermediary between the browser and the tunnel.
 */

import { createHash, randomBytes } from "node:crypto";

export const TOKEN_BYTES = 32;

/** A new session token. Returned once, to the browser; never stored in the clear. */
export function newToken(): string {
  return randomBytes(TOKEN_BYTES).toString("base64url");
}

/** What the sessions table holds: sha256(token), lowercase hex, 64 characters. */
export function tokenHash(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}
