/**
 * lib/http/request.ts -- what a request says about where it came from.
 *
 * Kept next to the Origin check that M4 will add, because both are the same question
 * asked twice: who is calling, and may I believe the headers that say so.
 *
 * The client address is the awkward one. Behind the Cloudflare Tunnel the socket peer
 * is the tunnel container, so every request in the world arrives from one address. If
 * rate limiting bucketed on that, one person fumbling their password would lock the
 * company out. The fix is `cf-connecting-ip`, which the tunnel sets and which anyone
 * on the public interface could also set -- so it is only read when the operator has
 * said, explicitly, that nothing but the tunnel can reach this process.
 */

import { config } from "../config";

/** A request, as far as these helpers need to know about it. */
interface RequestLike {
  headers: Headers;
  ip?: string;
}

/**
 * The address to attribute this request to, or null when it cannot be attributed.
 *
 * Null is a real answer and callers must handle it: with VKON_TRUST_PROXY_HEADERS
 * unset in front of something that rewrites addresses, there is no honest per-client
 * key, and bucketing on the tunnel's own address is worse than not bucketing. A
 * per-account limit still works, because that does not depend on the address at all.
 */
export function clientIp(req: RequestLike): string | null {
  const headers = req.headers;

  if (config().trustProxyHeaders) {
    const cf = headers.get("cf-connecting-ip");
    if (cf) {
      const value = cf.trim();
      // A single address, not a list and not an empty string: `cf-connecting-ip` is one
      // hop, and anything else means something in front is not what we think it is.
      if (value && !value.includes(",") && isAddress(value)) return value;
    }
    // A tunnel that is not setting it, or a proxy chain that is: take the leftmost
    // X-Forwarded-For entry only when the operator has said the whole path is trusted.
    const xff = headers.get("x-forwarded-for");
    const first = xff ? xff.split(",")[0].trim() : "";
    if (first && isAddress(first)) return first;
  }

  // The socket peer as Next reports it. Loopback in development, the tunnel container in
  // production, and never a value an attacker chose.
  const peer = typeof req.ip === "string" ? req.ip : "";
  return peer && isAddress(peer) ? peer : null;
}

const IPV4 = /^(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;
const IPV6 = /^[0-9a-f:]+$/i;

/** Deliberately permissive about IPv6 shapes and strict about IPv4: the value is stored
 *  and later compared, not used to build anything, so a false negative costs a bucket
 *  key while a false positive could not. */
function isAddress(value: string): boolean {
  if (value.includes(":")) return IPV6.test(value) && value.length <= 45;
  return IPV4.test(value);
}

/** The User-Agent, capped. It is stored for a person to read, not parsed. */
export function userAgent(req: RequestLike): string | null {
  const raw = req.headers.get("user-agent");
  if (!raw) return null;
  const value = raw.trim().slice(0, 400);
  return value || null;
}
