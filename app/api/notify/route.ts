/**
 * app/api/notify/route.ts -- send one notification to an employee's own email.
 *
 * The regularisation / loss-of-pay warnings are computed in the browser and shown on
 * the dashboard. This route is the one step that lets them also reach the person's
 * Gmail, so a warning is not invisible to somebody who has not opened the portal. It
 * sends nothing on its own initiative and takes no address from the caller.
 *
 * The three rules that make that safe, and why each lives here:
 *
 *   1. THE RECIPIENT IS RESOLVED SERVER-SIDE. The request names only an employee CODE;
 *      the address is read out of the portal's own roster document (`vkon_employees_v6`)
 *      through readDocument(). A body that carried a `to:` would turn this into an open
 *      mail relay -- exactly the endpoint an attacker wants. It does not, so it cannot be.
 *   2. YOU MAY ONLY MAIL YOURSELF, unless you are an admin. The warning a person is
 *      forwarding is always about the signed-in employee, so `employeeId` is checked
 *      against the session; an admin may notify any employee (the console acting on a
 *      person's behalf). Without this one employee's tab could spam another's inbox.
 *   3. IT IS INERT WITHOUT CONFIG. If SMTP is not set up (config().mail.enabled is false,
 *      the default), the request succeeds as `{ sent: false }` rather than erroring -- the
 *      client fires this in the background and must never surface a failure for a feature
 *      a given deployment simply does not have.
 *
 * Like every non-GET here it carries the same-origin lock (M4). A POST is state-changing
 * because it sends an email, even though it stores nothing.
 */

import type { NextRequest } from "next/server";
import { requireSession } from "@/lib/http/require-session";
import { assertSameOrigin } from "@/lib/http/guard";
import { expectObject, json, readJsonBody, requireString } from "@/lib/http/json";
import { errorResponse, forbidden } from "@/lib/http/errors";
import { readDocument } from "@/lib/state/documents";
import { isMailEnabled, sendNotificationMail } from "@/lib/mail";

export const dynamic = "force-dynamic";

/** The portal's roster store, read on the server to resolve the recipient address. */
const EMPLOYEES_KEY = "vkon_employees_v6";
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

interface RosterEntry {
  id?: string;
  email?: string | null;
}

/**
 * Best-effort once-per-day guard, so two open tabs (or a tab and a phone) do not mail
 * the same warning twice on one day. Cleared on restart and capped in size; it is a
 * courtesy dedup, not a security control -- the client also throttles per employee/day.
 */
const sentToday = new Set<string>();
const DAY_KEY_IST = (() => {
  // The portal's day rolls on IST; matching that here means "once per portal-day" and
  // "once per payroll-day" agree, rather than a mail slipping across the midnight gap.
  const now = new Date();
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" })
    .format(now);
})();

export async function POST(req: NextRequest): Promise<Response> {
  try {
    assertSameOrigin(req);
    const session = await requireSession(req);

    const body = expectObject(await readJsonBody(req, 8192));
    const employeeId = requireString(body, "employeeId", 64).toUpperCase();
    const subject = requireString(body, "subject", 200);
    const text = requireString(body, "text", 4000);

    // Rule 2: a caller may only cause a mail to their own address, an admin to any.
    if (session.role !== "admin" && session.employeeCode.toUpperCase() !== employeeId) {
      throw forbidden("You can only send notifications to your own account.");
    }

    // Rule 1: resolve the address from the server's roster copy, never from the body.
    const roster = (await readDocument<RosterEntry[]>(EMPLOYEES_KEY)) || [];
    const entry = roster.find((e) => String(e.id || "").toUpperCase() === employeeId);
    // A roster row is authoritative; the session email (employees table) is the fallback
    // for the signed-in person if the shared document has not caught up with an edit yet.
    const email = (entry && typeof entry.email === "string" && entry.email.trim())
      ? entry.email.trim()
      : (employeeId === session.employeeCode.toUpperCase() && session.email ? session.email.trim() : "");

    if (!email || !EMAIL_RE.test(email)) {
      // Not an error the person needs to see: nothing on file to send to.
      return json({ sent: false, reason: "no_address" });
    }

    // Rule 3: no SMTP configured -- succeed quietly, send nothing.
    if (!isMailEnabled()) {
      return json({ sent: false, reason: "not_configured" });
    }

    const dedupeKey = `${employeeId}|${DAY_KEY_IST}`;
    if (sentToday.has(dedupeKey)) {
      return json({ sent: false, reason: "already_sent_today" });
    }

    await sendNotificationMail({ to: email, subject, text });
    if (sentToday.size > 5000) sentToday.clear(); // bounded; a restart also clears it
    sentToday.add(dedupeKey);

    return json({ sent: true });
  } catch (err) {
    return errorResponse(err, "POST /api/notify");
  }
}
