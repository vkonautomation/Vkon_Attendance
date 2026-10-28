/**
 * app/api/punches/route.ts -- the punch endpoint, thin over lib/punches.
 *
 * The route does only what a route should: prove who is asking, decide whether they may
 * book this punch, translate the JSON into a validated command, and turn the outcome into
 * the response js/api.js expects. Every decision about the day, the fence, and idempotency
 * lives in lib/punches so it is one place to test and one place the /state projection reads.
 *
 * The authorisation rule is copied from the outgoing backend (server/api.py) exactly: the
 * employee may book their own punches; only an admin may name someone else. There is no
 * endpoint here that trusts a browser's claim of who it is -- the target code is checked
 * against the session, and the coordinates are stored while the geofence verdict is drawn
 * server-side (see lib/punches.ts).
 */

import type { NextRequest } from "next/server";
import { config } from "@/lib/config";
import { requireSession } from "@/lib/http/require-session";
import { assertSameOrigin } from "@/lib/http/guard";
import { expectObject, json, readJsonBody, requireString } from "@/lib/http/json";
import { badRequest, errorResponse, forbidden } from "@/lib/http/errors";
import { clientIp } from "@/lib/http/request";
import { recordAudit } from "@/lib/db/audit";
import { listPunches, recordPunch, type PunchCommand } from "@/lib/punches";

export const dynamic = "force-dynamic";

/** A coordinate/accuracy field: a finite number, or null (absent). */
function numField(obj: Record<string, unknown>, key: string): number | null {
  const raw = obj[key];
  if (raw === undefined || raw === null || raw === "") return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw badRequest(`\`${key}\` must be a number.`, "invalid_field");
  return n;
}

/**
 * The portal's employee code, upper-cased for the schema (employees.employee_code is
 * stored upper-case). Absent means "the signed-in employee", the same default the old
 * backend applied when `body.employeeId` was empty.
 */
function targetCode(body: Record<string, unknown>, ownCode: string): string {
  const raw = typeof body.employeeId === "string" ? body.employeeId.trim() : "";
  return raw ? raw.toUpperCase() : ownCode;
}

export async function POST(req: NextRequest): Promise<Response> {
  try {
    // Second CSRF lock (M4): a cross-origin punch POST is refused before anything is written.
    assertSameOrigin(req);
    const session = await requireSession(req);
    const body = expectObject(await readJsonBody(req, config().maxBodyBytes.punch));

    const punchId = requireString(body, "punchId", 200);
    const kind = body.kind;
    if (kind !== "in" && kind !== "out") {
      throw badRequest("kind must be 'in' or 'out'.", "bad_kind");
    }

    const employeeCode = targetCode(body, session.employeeCode);
    if (employeeCode !== session.employeeCode && session.role !== "admin") {
      throw forbidden("You may only record your own punches.");
    }

    const cmd: PunchCommand = {
      punchId,
      kind,
      employeeCode,
      clientCapturedAt: typeof body.clientCapturedAt === "string" ? body.clientCapturedAt : null,
      latitude: numField(body, "latitude"),
      longitude: numField(body, "longitude"),
      accuracyM: numField(body, "accuracyM"),
    };

    const result = await recordPunch(cmd);

    // The verdict, not the raw coordinates, is what is worth an audit line: coordinates in
    // an append-only log would turn the fence into a location history (see lib/db/audit.ts).
    await recordAudit({
      actorEmployeeId: session.employeeId,
      action: `punch.${kind}`,
      entityType: "record",
      entityId: `${result.employeeId}:${result.istDate}`,
      detail: {
        punchId,
        istDate: result.istDate,
        inside: result.insideGeofence,
        duplicate: result.duplicate,
        closedPriorDay: result.closedPriorDay,
      },
      ip: clientIp(req),
    });

    return json(result);
  } catch (err) {
    return errorResponse(err, "POST /api/punches");
  }
}

export async function GET(req: NextRequest): Promise<Response> {
  try {
    const session = await requireSession(req);
    const url = new URL(req.url);
    const date = url.searchParams.get("date");
    const named = url.searchParams.get("employeeId");

    // Same scoping rule as the old backend: an admin may name an employee or see everyone;
    // everyone else is confined to their own history, whatever `employeeId` they send.
    const restrictToCode = session.role === "admin" ? null : session.employeeCode;
    const employeeCode =
      session.role === "admin" && named ? named.toUpperCase() : null;

    const punches = await listPunches({
      restrictToCode,
      employeeCode,
      date: date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null,
    });
    return json({ punches });
  } catch (err) {
    return errorResponse(err, "GET /api/punches");
  }
}
