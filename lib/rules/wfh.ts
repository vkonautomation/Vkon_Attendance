/**
 * lib/rules/wfh.ts -- how many WFH days a week already used.
 *
 * Ported verbatim from public/shared.js. The subtle part that must not be "simplified":
 * the count is the union of APPROVED WFH requests AND actual WFH punch records, de-duped by
 * date. An approved request that was also punched still counts once, and a punched WFH day
 * with no separate request still counts -- so a worked WFH day always consumes its week's
 * allowance. Reading only one of the two sources under-counts and lets a person over-WFH.
 */

import type { RuleInputs } from "./types";
import { weekKey } from "./ist";

export const WEEKLY_WFH_ALLOWANCE = 2;

/** WFH days used in a week: approved requests + actual WFH punches, deduped by date. */
export function countWfhUsedInWeek(inputs: RuleInputs, empId: string, wk: string): number {
  const dates = new Set<string>();
  inputs.wfh.forEach((w) => {
    if (w.employeeId === empId && w.status === "Approved" && w.weekKey === wk && w.date) dates.add(w.date);
  });
  Object.keys(inputs.records).forEach((k) => {
    const r = inputs.records[k];
    if (r && r.employeeId === empId && r.status === "WFH" && r.date) {
      try {
        if (weekKey(new Date(r.date + "T00:00:00")) === wk) dates.add(r.date);
      } catch {
        /* ignore malformed date */
      }
    }
  });
  return dates.size;
}
