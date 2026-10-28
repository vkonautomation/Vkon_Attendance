/**
 * app/api/state/[key]/route.ts -- publish one shared store (the D1 facade's write).
 *
 * This is the single endpoint behind every browser mutation: shared.js `setStore()` still
 * writes localStorage and, when the server adapter is live, hands the value here through
 * js/api.js `flush()`. The body is `{ baseVersion, value }` and the answer is `{ version }`
 * -- or a 409 the tab adopts, a 403 it surfaces, or a 401 that stops the retry loop.
 *
 * The path names the portal's own store key (`vkon_employees_v6`), the same string the
 * browser holds in localStorage; there is no server-side rename to learn (D1). All the
 * decisions that make this safe -- is it a shared key, who may write it, does the caller's
 * version still match -- live in lib/state/documents.ts, so this handler is the transport:
 * authenticate, gate the origin, bound the body, and hand off.
 *
 * A PUT is state-changing, so it carries both M4 locks: the same-origin check and the
 * document body ceiling (2 MiB by default -- a whole roster or a month of records fits, a
 * upload disguised as a store does not).
 */

import type { NextRequest } from "next/server";
import { config } from "@/lib/config";
import { requireSession } from "@/lib/http/require-session";
import { assertSameOrigin } from "@/lib/http/guard";
import { expectObject, json, readJsonBody } from "@/lib/http/json";
import { badRequest, errorResponse } from "@/lib/http/errors";
import { clientIp } from "@/lib/http/request";
import { putDocument } from "@/lib/state/documents";

export const dynamic = "force-dynamic";

export async function PUT(
  req: NextRequest,
  context: { params: Promise<{ key: string }> },
): Promise<Response> {
  try {
    assertSameOrigin(req);
    const session = await requireSession(req);

    const { key } = await context.params;
    const body = expectObject(await readJsonBody(req, config().maxBodyBytes.state));

    if (!("value" in body)) {
      throw badRequest("`value` is required.", "missing_field");
    }
    const baseVersion = body.baseVersion;
    if (typeof baseVersion !== "number" || !Number.isInteger(baseVersion) || baseVersion < 0) {
      throw badRequest("`baseVersion` must be a non-negative integer.", "invalid_base_version");
    }

    const version = await putDocument({
      key,
      value: body.value,
      baseVersion,
      role: session.role,
      actorEmployeeId: session.employeeId,
      ip: clientIp(req),
    });

    return json({ version });
  } catch (err) {
    return errorResponse(err, "PUT /api/state/[key]");
  }
}
