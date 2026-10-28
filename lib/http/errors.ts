/**
 * lib/http/errors.ts -- the only error shape the API produces.
 *
 * js/api.js reads exactly two things out of a failed response:
 *
 *   body.error.message  what to show the person
 *   body.error.reason   what to do about it ("password_change_required" gates the whole
 *                       portal, so it is part of the contract, not a detail)
 *
 * So this file produces that shape and nothing else. Every path that can fail goes
 * through here, which is what makes "no internal detail reaches a browser" a property
 * of the code rather than of everybody remembering to sanitise.
 *
 * A 500 is the case that matters. An unexpected exception carries a Postgres message,
 * a connection string, or a stack frame with a file path in it -- all of which describe
 * the server rather than the problem, and one of which may name a person. The client
 * gets a generic sentence and a reference id; the real error goes to the log under the
 * same id, so the two can be joined by somebody who has shell access.
 */

import { randomBytes } from "node:crypto";

export class ApiError extends Error {
  readonly status: number;
  readonly reason?: string;
  /** Extra fields merged into body.error -- currentValue/currentVersion for a 409. */
  readonly extra?: Record<string, unknown>;

  constructor(status: number, message: string, options: { reason?: string; extra?: Record<string, unknown> } = {}) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.reason = options.reason;
    this.extra = options.extra;
  }
}

export const badRequest = (message: string, reason?: string) =>
  new ApiError(400, message, reason ? { reason } : undefined);

export const unauthorized = (message = "Sign in again to continue.") =>
  new ApiError(401, message);

export const passwordChangeRequired = () =>
  new ApiError(403, "Choose a new password before you continue.", { reason: "password_change_required" });

export const forbidden = (message = "That action is not permitted for your account.", reason?: string) =>
  new ApiError(403, message, reason ? { reason } : undefined);

export const notFound = (message = "There is nothing at that address.") =>
  new ApiError(404, message);

export const payloadTooLarge = (message: string) =>
  new ApiError(413, message, { reason: "payload_too_large" });

export const tooManyRequests = (message: string, retryAfterSeconds: number) =>
  new ApiError(429, message, { reason: "rate_limited", extra: { retryAfter: retryAfterSeconds } });

/** A string the person can quote. Eight hex characters is not a secret and does not
 *  need to be one -- it identifies a log line, not an account. */
export function referenceId(): string {
  return randomBytes(4).toString("hex");
}

export interface ErrorBody {
  error: { message: string; reason?: string; ref?: string } & Record<string, unknown>;
}

export function errorBody(err: unknown, ref?: string): ErrorBody {
  if (err instanceof ApiError) {
    const body: ErrorBody["error"] = { message: err.message };
    if (err.reason) body.reason = err.reason;
    if (err.extra) Object.assign(body, err.extra);
    if (ref) body.ref = ref;
    return { error: body };
  }
  // Anything unexpected: say nothing about it. The message below is written for a
  // person reading it on a phone, and it names no field, no account and no component.
  return { error: { message: "Something went wrong on the attendance server. Try again in a moment.", ...(ref ? { ref } : {}) } };
}

/**
 * Turn anything a handler threw into a response, logging what it actually was.
 *
 * Call this at the edge of every route handler. It is the difference between an
 * incident and a mystery: the browser sees a generic sentence either way, but the log
 * carries the reference id the person was shown.
 */
export function errorResponse(err: unknown, context: string): Response {
  const ref = referenceId();
  const status = err instanceof ApiError ? err.status : 500;

  if (!(err instanceof ApiError)) {
    // A client error is expected traffic; only the unexpected branch is a log line.
    console.error(`[http] ${context} ref=${ref}:`, err instanceof Error ? err.stack || err.message : err);
  }

  return new Response(JSON.stringify(errorBody(err, status >= 500 ? ref : undefined)), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}
