/**
 * lib/http/json.ts -- responses, and a request body that cannot be too big.
 *
 * The body limit is enforced while reading, not after. `await req.json()` on a 400 MB
 * upload allocates 400 MB first and then complains, which on a host with a gigabyte of
 * RAM is the difference between a refused request and a stopped container. So the
 * stream is counted chunk by chunk and cancelled the moment it exceeds the ceiling:
 * the bytes are never all in memory at once, and the sender finds out immediately.
 *
 * `Content-Length` is checked first because it rejects the obvious case without reading
 * anything, but it is a claim rather than a fact -- a chunked body has none, and a
 * lying client exists -- so the real limit is the counter.
 */

import { badRequest, payloadTooLarge } from "./errors";

export interface JsonInit {
  status?: number;
  headers?: Record<string, string>;
  /** At most one cookie per response. See lib/auth/cookie.ts for why that is safe. */
  setCookie?: string;
}

export function json(data: unknown, init: JsonInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("Content-Type", "application/json; charset=utf-8");
  headers.set("Cache-Control", "no-store");
  if (init.setCookie) headers.set("Set-Cookie", init.setCookie);
  return new Response(data === undefined ? null : JSON.stringify(data), {
    status: init.status ?? 200,
    headers,
  });
}

/** Add a Set-Cookie to a response that has already been built (the error paths). */
export function withCookie(res: Response, cookie: string): Response {
  res.headers.set("Set-Cookie", cookie);
  return res;
}

/**
 * Parse a JSON body under a byte ceiling. Throws an ApiError on every failure, so a
 * handler that forgets to check simply does not run.
 */
export async function readJsonBody(req: Request, maxBytes: number): Promise<unknown> {
  const declared = Number(req.headers.get("content-length") || "");
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw payloadTooLarge("That request is too large for this endpoint.");
  }

  let text = "";
  if (req.body) {
    const reader = req.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        // Cancel rather than leave the stream half-read: the connection is reused, and
        // unread bytes would be the next request's body.
        await reader.cancel().catch(() => { /* already closed */ });
        throw payloadTooLarge("That request is too large for this endpoint.");
      }
      chunks.push(value);
    }
    const buf = new Uint8Array(total);
    let offset = 0;
    for (const c of chunks) { buf.set(c, offset); offset += c.byteLength; }
    text = new TextDecoder("utf-8").decode(buf);
  }

  if (!text.trim()) throw badRequest("A request body is required.", "empty_body");
  try {
    return JSON.parse(text);
  } catch {
    throw badRequest("The request body is not valid JSON.", "invalid_json");
  }
}

/** A JSON object or nothing: every endpoint here takes one, and an array or a bare
 *  string reaching a field lookup is how `undefined` becomes a 500. */
export function expectObject(value: unknown, what = "The request body"): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw badRequest(`${what} must be a JSON object.`, "invalid_shape");
  }
  return value as Record<string, unknown>;
}

/**
 * A required non-empty string, trimmed and capped. The cap matters: these values are
 * written into rows and into the audit log, and a field with no ceiling is a body limit
 * that moved.
 */
export function requireString(obj: Record<string, unknown>, key: string, max = 512): string {
  const raw = obj[key];
  if (typeof raw !== "string" || !raw.trim()) {
    throw badRequest(`\`${key}\` is required.`, "missing_field");
  }
  const value = raw.trim();
  if (value.length > max) throw badRequest(`\`${key}\` is too long.`, "field_too_long");
  return value;
}

/** An optional string, or null. Same cap, no exception for absence. */
export function optionalString(obj: Record<string, unknown>, key: string, max = 512): string | null {
  const raw = obj[key];
  if (raw === undefined || raw === null || raw === "") return null;
  if (typeof raw !== "string") throw badRequest(`\`${key}\` must be text.`, "invalid_field");
  const value = raw.trim();
  if (value.length > max) throw badRequest(`\`${key}\` is too long.`, "field_too_long");
  return value || null;
}
