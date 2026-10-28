/**
 * app/api/state/route.ts -- the whole shared state in one read (the D1 facade).
 *
 * js/api.js `hydrate()` and `pull()` hit exactly this path and expect
 * `{ stores: { key: { value, version } }, serverVersion }`. It is a projection, not a
 * query: the browser wants every shared store at once because that is how its
 * synchronous getStore() cache was built, and rewriting ~190 call sites to fetch per store
 * is out of scope (D1).
 *
 * Any authenticated account may read the projection: role scoping of the *content* is a
 * property of the M11 relational projection, not of this transitional document layer,
 * where the front end already applies its own view filtering. The credential store the
 * server must never hand back is suppressed inside readStateDocuments(), not here, so the
 * rule lives with the data policy rather than being re-implemented per caller.
 *
 * GET changes nothing, so -- as with the roster read -- it is not origin-gated.
 */

import type { NextRequest } from "next/server";
import { requireSession } from "@/lib/http/require-session";
import { json } from "@/lib/http/json";
import { errorResponse } from "@/lib/http/errors";
import { readStateDocuments } from "@/lib/state/documents";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<Response> {
  try {
    await requireSession(req);
    return json(await readStateDocuments());
  } catch (err) {
    return errorResponse(err, "GET /api/state");
  }
}
