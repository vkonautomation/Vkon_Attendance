/**
 * lib/rules/alerts.ts -- "you missed a workday" regularisation alerts, computed never stored.
 *
 * Ported verbatim from public/shared.js. The pure-read contract matters: a backend job will
 * reuse this exact function for email/push, so what the banner shows and what the job sends
 * must be the same computation. Details the harness pins down:
 *   - The scan window reaches ~3 months back so a day stays "critical" after its next-month
 *     payroll close, and it walks the range as LOCAL dates keyed by istDateKey -- reproducing
 *     the browser's exact local-getDay / IST-key mix, not a "cleaner" UTC version.
 *   - A day is resolved by a punch, an approved leave/WFH, or a LIVE (not rejected/cancelled)
 *     regularisation; a rejected one keeps the alert and changes its wording. The urgency and
 *     the deadline come from the SAME _payrollCutOffKeyFor that the LOP conversion uses, so
 *     the "regularise by X" date and the day it turns into LOP can never disagree.
 */

import type { RuleInputs, Employee, Record_, LeaveRequest, WfhRequest, Regularisation, AttendanceSettings } from "./types";
import { getISTDate, istDateKey, payrollCutOffKeyFor, diffDaysUTC, prettyDateKey, isOpenPunch } from "./ist";
import { isNonWorkingDay } from "./holidays";

export interface RegularisationAlert {
  empId: string;
  dateStr: string;
  statusLabel: string;
  daysLeft: number;
  pastCutOff: boolean;
  urgency: "critical" | "warning" | "info";
  rejected: boolean;
  deadlineKey: string | null;
  message: string;
  occurredAt: string;
}

/** The set of YYYY-MM-DD dates an APPROVED request (leave or WFH) covers, so they are never flagged. */
export function approvedCoverageDates(
  list: (LeaveRequest | WfhRequest | Regularisation)[],
  empId: string,
): Set<string> {
  const set = new Set<string>();
  (Array.isArray(list) ? list : []).forEach((r) => {
    if (!r || r.employeeId !== empId || r.status !== "Approved") return;
    const rec = r as { date?: string; startDate?: string; endDate?: string };
    if (rec.date) {
      set.add(rec.date);
      return;
    }
    if (rec.startDate && rec.endDate) {
      const cur = new Date(rec.startDate + "T00:00:00");
      const end = new Date(rec.endDate + "T00:00:00");
      while (cur <= end) {
        set.add(istDateKey(cur));
        cur.setDate(cur.getDate() + 1);
      }
    } else if (rec.startDate) {
      set.add(rec.startDate);
    }
  });
  return set;
}

/** THE alert calculator: one object per unresolved past workday, most urgent first. */
export function getRegularisationAlerts(
  inputs: RuleInputs,
  employee: Employee | null,
  now: Date,
  settings?: AttendanceSettings,
): RegularisationAlert[] {
  const emp = employee || null;
  if (!emp || !emp.id) return [];
  const s = settings || inputs.settings;
  // Emulate shared.js's `getNowIST()` (which is getISTDate applied to the raw instant,
  // server offset 0) so the IST-key and windowStart maths below line up field-for-field.
  const n = getISTDate(now);
  const todayKey = istDateKey(n);

  const records: Record<string, Record_> = inputs.records;

  // Index this employee's regularisation requests by date.
  const regByDate: Record<string, Regularisation[]> = {};
  inputs.regularisations.forEach((r) => {
    if (r.employeeId === emp.id) (regByDate[r.date] = regByDate[r.date] || []).push(r);
  });
  const leaveDates = approvedCoverageDates(inputs.leaves, emp.id);
  const wfhDates = approvedCoverageDates(inputs.wfh, emp.id);

  // Scan window: ~3 months back through yesterday.
  const ist = getISTDate(n);
  const windowStart = new Date(ist.getFullYear(), ist.getMonth() - 2, 1);
  const enrolledKey = emp.enrolledAt || null;
  const alerts: RegularisationAlert[] = [];

  for (let cur = new Date(windowStart); ; cur.setDate(cur.getDate() + 1)) {
    const dateStr = istDateKey(cur);
    if (dateStr >= todayKey) break; // exclude today & future
    if (enrolledKey && dateStr < enrolledKey) continue; // before enrollment
    const dow = cur.getDay();
    if (dow === 0 || dow === 6) continue; // weekends always excluded
    if (isNonWorkingDay(inputs, dateStr, emp.id)) continue; // declared/RH holidays off
    if (leaveDates.has(dateStr) || wfhDates.has(dateStr)) continue; // approved leave/WFH

    const rec = records[`${emp.id}_${dateStr}`];
    let statusLabel: string | null = null;
    if (rec) {
      const st = rec.status;
      if (st === "Absent") statusLabel = "Absent";
      else if ((st === "Present" || st === "WFH") && isOpenPunch(rec)) statusLabel = "Absent";
      // completed Present/WFH, Leave, Holiday, Loss of Pay => resolved, skip.
    } else {
      statusLabel = "Not Marked";
    }
    if (!statusLabel) continue;

    // A live (not rejected/cancelled) request pending or approved resolves the day.
    const dayRegs = regByDate[dateStr] || [];
    if (dayRegs.some((r) => r.status !== "Rejected" && r.status !== "Cancelled")) continue;
    const rejected = dayRegs.some((r) => r.status === "Rejected");

    const deadlineKey = payrollCutOffKeyFor(dateStr, s.payrollCutOffDay);
    const daysLeft = deadlineKey ? diffDaysUTC(todayKey, deadlineKey) : 0;
    const pastCutOff = !deadlineKey || daysLeft < 0;
    const urgency: RegularisationAlert["urgency"] = pastCutOff ? "critical" : daysLeft <= 3 ? "warning" : "info";

    const when = prettyDateKey(dateStr);
    let message: string;
    if (pastCutOff) {
      message = `${when} was not regularised and is counted as a full day of LOP.`;
    } else if (rejected) {
      message = `${when} \u2014 regularisation request rejected, you can resubmit. Regularise by ${prettyDateKey(deadlineKey as string)} or it will count as a full day of LOP.`;
    } else {
      message = `${when} is marked ${statusLabel}. Regularise by ${prettyDateKey(deadlineKey as string)} or it will count as a full day of LOP.`;
    }

    alerts.push({
      empId: emp.id,
      dateStr,
      statusLabel,
      daysLeft,
      pastCutOff,
      urgency,
      rejected,
      deadlineKey,
      message,
      occurredAt: `${dateStr}T23:59:59`,
    });
  }

  const RANK: Record<string, number> = { critical: 0, warning: 1, info: 2 };
  alerts.sort((a, b) => (RANK[a.urgency] - RANK[b.urgency]) || (a.dateStr < b.dateStr ? -1 : a.dateStr > b.dateStr ? 1 : 0));
  return alerts;
}
