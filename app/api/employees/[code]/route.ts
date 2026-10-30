/**
 * app/api/employees/[code]/route.ts -- change one employee, admin only.
 *
 * The path names the portal's employee code ("EMP001"), never the uuid: the uuid is the
 * database's private key and the whole front end keys off the code (D1). A PATCH is partial:
 * only the fields actually present in the body are touched, so switching someone's `active`
 * flag cannot overwrite their salary with a null, and a manager re-org writes exactly the
 * pointer it means to.
 *
 * The rule that makes this milestone worth its name lives here and in lib/roster: changing
 * `managerCode` re-runs the 0007 cycle check, so an admin who tries to file a manager under
 * one of their own reports is refused on this request rather than leaving a loop for the
 * approval router to fall into later. Deactivating (`active: false`) takes effect on the
 * subject's very next request, because requireSession() reads `active` from the row every time
 * -- there is no second cache of "is this person still allowed" to invalidate.
 */

import type { NextRequest } from "next/server";
import { config } from "@/lib/config";
import { requireSession } from "@/lib/http/require-session";
import { assertSameOrigin } from "@/lib/http/guard";
import { expectObject, json, optionalString, readJsonBody, requireString } from "@/lib/http/json";
import { boolField, enumField, isoDateField, numOrNullField } from "@/lib/http/fields";
import { errorResponse, forbidden } from "@/lib/http/errors";
import { clientIp } from "@/lib/http/request";
import { recordAudit } from "@/lib/db/audit";
import { updateEmployee, deleteEmployee, type AccessRole, type EmployeePatch } from "@/lib/roster";

export const dynamic = "force-dynamic";

const ACCESS_ROLES: readonly AccessRole[] = ["employee", "manager", "admin"];

export async function PATCH(
  req: NextRequest,
  context: { params: Promise<{ code: string }> },
): Promise<Response> {
  try {
    assertSameOrigin(req);
    const session = await requireSession(req);
    if (session.role !== "admin") {
      throw forbidden("Only an administrator may change employees.");
    }

    const { code } = await context.params;
    const target = code.toUpperCase();

    const body = expectObject(await readJsonBody(req, config().maxBodyBytes.roster));

    // Presence-gated: `in body` decides what the caller actually sent. optionalString/boolField
    // return a value for an *empty* field too, so the `in` test -- not the reader -- is what
    // distinguishes "set this to null" from "leave this alone".
    const patch: EmployeePatch = {};
    if ("name" in body) patch.name = requireString(body, "name", 128);
    if ("email" in body) patch.email = optionalString(body, "email", 254);
    if ("jobTitle" in body) patch.jobTitle = optionalString(body, "jobTitle", 128);
    if ("department" in body) patch.department = optionalString(body, "department", 128);
    if ("accessRole" in body) patch.accessRole = enumField(body, "accessRole", ACCESS_ROLES);
    if ("managerCode" in body) {
      patch.managerCode = optionalString(body, "managerCode", 64)?.toUpperCase() ?? null;
    }
    if ("monthlySalary" in body) patch.monthlySalary = numOrNullField(body, "monthlySalary");
    if ("geofenceEnabled" in body) patch.geofenceEnabled = boolField(body, "geofenceEnabled", true);
    if ("active" in body) patch.active = boolField(body, "active", true);
    if ("joinedOn" in body) patch.joinedOn = isoDateField(body, "joinedOn");

    const updated = await updateEmployee(target, patch);

    // Only the fields that changed are recorded: the audit log is a story of decisions, and a
    // `manager` entry is the one an investigation looks for first (a loop, a re-org, a removal).
    await recordAudit({
      actorEmployeeId: session.employeeId,
      action: "roster.update",
      entityType: "employee",
      entityId: updated.id,
      detail: {
        changed: Object.keys(patch),
        active: updated.active,
        role: updated.accessRole,
        manager: updated.managerId,
      },
      ip: clientIp(req),
    });

    return json({ employee: updated });
  } catch (err) {
    return errorResponse(err, "PATCH /api/employees/[code]");
  }
}

/**
 * Remove an employee for good. This is the delete the roster screen's trash button calls: the
 * sign-in account goes and, with it, the cascaded attendance/leave/WFH/regularisation rows, so
 * the `EMPnnn` is freed and the next enrolment reuses it. Admin-only and same-origin like the
 * PATCH. The audit trail keeps the departed employee's past entries (actor nulled) and gains one
 * recording who removed them.
 */
export async function DELETE(
  req: NextRequest,
  context: { params: Promise<{ code: string }> },
): Promise<Response> {
  try {
    assertSameOrigin(req);
    const session = await requireSession(req);
    if (session.role !== "admin") {
      throw forbidden("Only an administrator may remove employees.");
    }

    const { code } = await context.params;
    const removed = await deleteEmployee(code);

    await recordAudit({
      actorEmployeeId: session.employeeId,
      action: "roster.delete",
      entityType: "employee",
      entityId: removed,
      detail: {},
      ip: clientIp(req),
    });

    return json({ removed });
  } catch (err) {
    return errorResponse(err, "DELETE /api/employees/[code]");
  }
}
