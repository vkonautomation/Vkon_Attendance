/**
 * lib/rules/holidays.ts -- declared vs restricted holidays, and the one question every
 * other rule ultimately asks: is this date a working day for this employee?
 *
 * Ported verbatim from public/shared.js. The distinction is load-bearing and preserved in
 * code, not comment: a Declared Holiday is off for everyone, but a Restricted Holiday only
 * hides punching for the employee whose restricted leave for that date was APPROVED (Req 7).
 * And an approved "worked on holiday" override reopens the day for that one person (Req 6).
 * Getting any of these three wrong silently changes who owes a day of attendance.
 */

import type { RuleInputs, Holiday } from "./types";
import { istDateKey } from "./ist";

export function declaredHolidays(inputs: RuleInputs): Holiday[] {
  return inputs.holidays.filter((h) => h.type === "Declared Holiday");
}

export function restrictedHolidays(inputs: RuleInputs): Holiday[] {
  return inputs.holidays.filter((h) => h.type === "Restricted Holiday");
}

/** The holiday record (if any) for a date, from the RAW set so BOTH types are seen. */
export function findHolidayForDate(inputs: RuleInputs, dateStr: string): Holiday | null {
  return inputs.holidays.find((h) => h.date === dateStr) || null;
}

function isRestrictedType(l: { category?: string; type?: string }): boolean {
  return (
    l.category === "Restricted" ||
    l.category === "RH" ||
    (l.type || "").indexOf("Restricted") !== -1
  );
}

/** Does this employee have an APPROVED restricted-holiday leave on the date? */
export function hasApprovedRestrictedLeaveOnDate(
  inputs: RuleInputs,
  empId: string | null,
  dateStr: string,
): boolean {
  if (!empId) return false;
  const hit = inputs.leaves.some(
    (l) =>
      l.employeeId === empId &&
      l.status === "Approved" &&
      isRestrictedType(l as { category?: string; type?: string }) &&
      (l.date
        ? l.date === dateStr
        : !!(l.startDate && l.endDate && dateStr >= l.startDate && dateStr <= l.endDate)),
  );
  if (hit) return true;
  // A materialised RH record (status Leave, locationType contains "RH") also counts.
  const rec = inputs.records[`${empId}_${dateStr}`];
  return !!(rec && rec.status === "Leave" && rec.locationType && rec.locationType.indexOf("RH") !== -1);
}

/** Was this employee marked as having worked a holiday that day? */
export function isWorkedOnHoliday(inputs: RuleInputs, empId: string | null, dateStr: string): boolean {
  if (!empId) return false;
  return !!inputs.holidayWork[`${empId}_${dateStr}`];
}

/**
 * THE single source of truth: is `date` a non-working day for this employee?
 * `date` may be a "YYYY-MM-DD" string or a Date; `employee` may be an id or an object.
 * Returns false when a worked-on-holiday override reopens the day.
 */
export function isNonWorkingDay(
  inputs: RuleInputs,
  date: string | Date,
  employee?: string | { id?: string } | null,
): boolean {
  try {
    const dateStr = typeof date === "string" ? date : istDateKey(date);
    const empId = employee
      ? typeof employee === "string"
        ? employee
        : employee.id || null
      : null;
    const s = inputs.settings;
    const dObj = new Date(dateStr + "T00:00:00");
    const dow = dObj.getDay();
    const isWeekend = dow === 0 || dow === 6;

    let nonWorking = false;
    const h = findHolidayForDate(inputs, dateStr);
    if (h) {
      if (h.type === "Restricted Holiday") {
        nonWorking = hasApprovedRestrictedLeaveOnDate(inputs, empId, dateStr);
      } else {
        nonWorking = true; // Declared Holiday is mandatory off for everyone
      }
    }
    if (!nonWorking && s.treatWeekendsAsNonWorking && isWeekend) nonWorking = true;
    if (!nonWorking) return false;

    // Req 6 exception: an approved worked-on-holiday override reopens the day.
    if (empId && isWorkedOnHoliday(inputs, empId, dateStr)) return false;
    return true;
  } catch {
    return false;
  }
}
