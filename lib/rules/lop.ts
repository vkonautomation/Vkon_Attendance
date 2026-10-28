/**
 * lib/rules/lop.ts -- the LOP day ledger, collapsed to WHOLE days.
 *
 * Ported verbatim from public/shared.js. Two things here are policy, not implementation
 * detail, and the conformance harness pins both down:
 *   - LOP is counted in whole days only. Legacy entries that carried a 0.5 fraction and
 *     any same-day duplicate source collapse to a single day, because the set is keyed by
 *     date. "Size of the day set" is the count -- never a sum of fractions.
 *   - Expanding an approved leave range skips weekends and DECLARED holidays, but NOT
 *     restricted holidays (an RH only removes the day for the one person who took it, and
 *     that is handled elsewhere). Copying the wrong holiday set here would over-deduct.
 */

import type { RuleInputs, LopEntry } from "./types";
import { istDateKey } from "./ist";
import { declaredHolidays } from "./holidays";

/** The SET of LOP dates for an employee in a 'YYYY-MM' month (whole days, deduped). */
export function getLopDatesForMonth(inputs: RuleInputs, empId: string, monthStr: string): Set<string> {
  const list = inputs.lopEntries.filter(
    (e: LopEntry) => e.employeeId === empId && e.status === "active" && e.date.slice(0, 7) === monthStr,
  );
  return new Set(list.map((e) => e.date));
}

/** Total LOP days for a month: each calendar day counts at most 1. */
export function computeLopDaysForMonth(inputs: RuleInputs, empId: string, monthStr: string): number {
  return getLopDatesForMonth(inputs, empId, monthStr).size;
}

export interface LopDay {
  date: string;
  fraction: number;
}

/**
 * Expand an approved leave range into whole-day LOP objects. Weekends and declared
 * holidays are skipped. Always fraction 1 (a half-day request counts as a whole day).
 */
export function lopDatesForRange(inputs: RuleInputs, startDate: string, endDate?: string): LopDay[] {
  const out: LopDay[] = [];
  const holSet = new Set(declaredHolidays(inputs).map((h) => h.date));
  const cur = new Date(startDate + "T00:00:00");
  const end = new Date((endDate || startDate) + "T00:00:00");
  while (cur <= end) {
    const key = istDateKey(cur);
    const wd = cur.getDay();
    const isOff = wd === 0 || wd === 6 || holSet.has(key);
    if (!isOff) out.push({ date: key, fraction: 1 });
    cur.setDate(cur.getDate() + 1);
  }
  return out;
}
