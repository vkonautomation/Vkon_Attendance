/**
 * app/api/employees/route.ts -- the roster: who may see it, and who may add to it.
 *
 * The route owns exactly two questions and delegates the rest to lib/roster:
 *
 *   1. WHO is asking? requireSession() resolves the person from the cookie and the database,
 *      so `session.role` is a fact about the row, not a claim in the request. That role picks
 *      the read scope (an admin sees everyone, a manager their team, an employee only themselves)
 *      and is the ONLY thing that authorises a write.
 *   2. MAY they write? Creating an employee is admin-only. A non-admin POST is refused with a 403
 *      before any parsing -- the request is never interpreted, because an endpoint that reasons
 *      about a body it will not act on is an endpoint that leaks a validation error to someone
 *      with no business seeing it.
 *
 * GET is not origin-gated (it changes nothing); POST is, on both locks M4 installed: the same
 * Origin check every non-GET carries, and the small roster body ceiling that stops this turning
 * into a document store.
 */

import type { NextRequest } from "next/server";
import { config } from "@/lib/config";
import { requireSession } from "@/lib/http/require-session";
import { assertSameOrigin } from "@/lib/http/guard";
import { expectObject, json, optionalString, readJsonBody, requireString } from "@/lib/http/json";
import { errorResponse, forbidden } from "@/lib/http/errors";
import { boolField, enumField, isoDateField, numOrNullField } from "@/lib/http/fields";
import { clientIp } from "@/lib/http/request";
import { recordAudit } from "@/lib/db/audit";
import { createEmployee, listRoster, type AccessRole, type NewEmployee } from "@/lib/roster";

export const dynamic = "force-dynamic";

const ACCESS_ROLES: readonly AccessRole[] = ["employee", "manager", "admin"];

export async function GET(req: NextRequest): Promise<Response> {
  try {
    const session = await requireSession(req);
    // The scope is chosen entirely from the session row; a query string cannot widen it. This
    // is what replaces the client-side roster filter shared.js applies today, moved server-side
    // so "who may see whom" is enforced rather than merely requested.
    return json({ employees: await listRoster(session) });
  } catch (err) {
    return errorResponse(err, "GET /api/employees");
  }
}

export async function POST(req: NextRequest): Promise<Response> {
  try {
    assertSameOrigin(req);
    const session = await requireSession(req);
    if (session.role !== "admin") {
      throw forbidden("Only an administrator may add employees.");
    }

    const body = expectObject(await readJsonBody(req, config().maxBodyBytes.roster));
    const cmd: NewEmployee = {
      employeeCode: requireString(body, "employeeCode", 64),
      username: requireString(body, "username", 64),
      name: requireString(body, "name", 128),
      email: optionalString(body, "email", 254),
      jobTitle: optionalString(body, "jobTitle", 128),
      department: optionalString(body, "department", 128),
      accessRole: enumField(body, "accessRole", ACCESS_ROLES, "employee"),
      managerCode: optionalString(body, "managerCode", 64)?.toUpperCase() ?? null,
      monthlySalary: numOrNullField(body, "monthlySalary"),
      geofenceEnabled: boolField(body, "geofenceEnabled", true),
      // Enrolment is the moment `active` becomes true (0002 defaults the column false): a row
      // created through the roster is a person who can sign in, unless the admin said otherwise.
      active: boolField(body, "active", true),
      joinedOn: isoDateField(body, "joinedOn"),
      // The administrator may set the starting password; blank makes the server issue a
      // one-time password. It is hashed on the way in and never stored or audited as text.
      password: optionalString(body, "password", 400),
    };

    const { employee, oneTimePassword } = await createEmployee(cmd);

    // Salary and geofence are policy the audit trail should be able to reconstruct; email is
    // personal, so only the code and the role-changing fields are recorded (see lib/db/audit.ts).
    // The one-time password is deliberately never recorded.
    await recordAudit({
      actorEmployeeId: session.employeeId,
      action: "roster.create",
      entityType: "employee",
      entityId: employee.id,
      detail: {
        role: employee.accessRole,
        active: employee.active,
        manager: employee.managerId,
        geofenceEnabled: employee.geofenceEnabled,
      },
      ip: clientIp(req),
    });

    // The starting password is returned exactly once, here, so the administrator can hand it
    // to the new person. The server stores only its hash.
    return json({ employee, oneTimePassword }, { status: 201 });
  } catch (err) {
    return errorResponse(err, "POST /api/employees");
  }
}
