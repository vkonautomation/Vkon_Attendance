/**
 * lib/http/guard.ts -- the second CSRF lock: does this request come from us?
 *
 * `SameSite=Lax` on the session cookie already stops the cookie riding on a cross-site
 * POST, so state-changing requests are protected from the ordinary drive-by form. This is
 * the belt to that braces: every non-GET compares the request's own declared origin
 * against the origin the portal is actually served from, and refuses anything else before
 * the handler runs. It catches the cases SameSite alone does not -- a mismatched scheme or
 * host, a `null` origin from a sandboxed frame, a request replayed against a different
 * vhost -- and it does so without needing to trust any header the way a proxy chain would.
 *
 * It is skipped entirely when `PUBLIC_ORIGIN` is unset (development), because there is
 * nothing honest to compare against, and inventing one from the Host header is precisely
 * how a spoofed host turns into a "same-origin" request. Production refuses to boot
 * without it (see lib/config.ts), so the check is always live where it matters.
 */

import { config } from "../config";
import { forbidden } from "./errors";

interface RequestLike {
  headers: Headers;
}

/**
 * The origin a browser says it sent the request from, or null if it said nothing usable.
 *
 * `Origin` is the modern, reliable one and is sent on every fetch/XHR POST. `Referer` is
 * the fallback for the older and for top-level form posts; only its own origin is used,
 * never the path or query. Both are parsed rather than string-matched so a trailing slash
 * or a `#fragment` cannot make two different origins look equal.
 */
function requestOrigin(req: RequestLike): string | null {
  const raw = req.headers.get("origin") || req.headers.get("referer");
  if (!raw) return null;
  const value = raw.trim();
  if (!value || value === "null") return null; // opaque / sandboxed origin
  try {
    const u = new URL(value);
    // A URL origin is scheme://host:port with no trailing slash -- exactly the shape
    // PUBLIC_ORIGIN is normalised to.
    return u.origin;
  } catch {
    return null;
  }
}

/**
 * Throw unless this state-changing request came from the portal's own origin.
 *
 * Call at the top of every non-GET handler. A missing origin counts as a mismatch on
 * purpose: a real browser always sends one on a fetch POST, so its absence means the
 * request was not made by the portal.
 */
export function assertSameOrigin(req: RequestLike): void {
  const expected = config().publicOrigin;
  if (!expected) return; // not configured (development): nothing honest to compare against

  const origin = requestOrigin(req);
  if (origin !== expected) {
    // One generic sentence for "no origin" and "wrong origin"; neither names the header
    // or the expected value, so a probe learns nothing about the configuration.
    throw forbidden("This request did not come from the attendance site.");
  }
}
