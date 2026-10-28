/**
 * lib/rules/day-status.ts -- the single source of truth for a punched day's derived state.
 *
 * Ported verbatim from public/shared.js. This is the code the calendar popover, the
 * dashboard tile and the admin master sheet all read, so they can never disagree -- which
 * only holds if the server reads the SAME function (D2). The two behaviours the conformance
 * harness must reproduce exactly:
 *   - classifyDay only fires for Present/WFH punches, returns "In Progress" for an open
 *     punch, honours an admin override, and -- crucially -- turns an under-worked day into
 *     a FULL-day LOP ("Short hours (LOP)", lopFraction 1) ONLY once the payroll month has
 *     closed. Before the cut-off it is "Short hours - review". Same clock, different answer.
 *   - getEffectiveStatus derives lateness from shiftStart (+ grace) and short-by from the
 *     required hours, both formatted "Xh YYm"; it carries the underlying `rec` through for
 *     callers, so the harness compares the derived fields, not the record pointer.
 */

import type { RuleInputs, Record_, AttendanceSettings } from "./types";
import {
  isOpenPunch,
  computeWorkedHours,
  parseClockToMinutes,
  isPastPayrollCutOff,
  formatMinutesHM,
} from "./ist";

export interface DayClassification {
  classification: string;
  worked: number;
  lopFraction?: number;
  rec?: Record_;
}

/** Classify one punched day against policy. Pure read; mutates nothing. */
export function classifyDay(
  inputs: RuleInputs,
  empId: string,
  date: string,
  now: Date,
  settings?: AttendanceSettings,
): DayClassification | null {
  const s = settings || inputs.settings;
  const rec = inputs.records[`${empId}_${date}`];
  if (!rec) return null;
  if (rec.status !== "Present" && rec.status !== "WFH") return null;
  if (isOpenPunch(rec)) return { classification: "In Progress", worked: 0, rec };

  const W = computeWorkedHours(rec);
  if (rec.overridePresent) {
    return { classification: "Present (Override)", worked: W, lopFraction: 0, rec };
  }

  let classification: string;
  let lopFraction = 0;
  if (W >= s.minPresentHours) {
    classification = "Present";
  } else if (isPastPayrollCutOff(date, s.payrollCutOffDay, now)) {
    // Under-worked day past the payroll cut-off: a FULL-day LOP (no half).
    classification = "Short hours (LOP)";
    lopFraction = 1;
  } else {
    classification = "Short hours - review";
  }
  return { classification, worked: W, lopFraction, rec };
}

/** The classification string a view should show for a record. */
export function displayStatusForRecord(rec?: Record_ | null): string {
  if (!rec) return "";
  return rec.dayClassification || rec.status || "";
}

export interface LateInfo {
  isLate: boolean;
  minutes: number;
  label: string;
}
export interface ShortInfo {
  isShort: boolean;
  hours: number;
  label: string;
}
export interface EffectiveStatus {
  status: string;
  classification: string;
  isOpen: boolean;
  isComplete: boolean;
  checkIn: string | null;
  checkOut: string | null;
  workedHours: number;
  late: LateInfo;
  short: ShortInfo;
  tags: { label: string; reason: string }[];
  rec: Record_;
}

/** THE single source of truth for a punched day's effective state; null for a non-punch. */
export function getEffectiveStatus(
  inputs: RuleInputs,
  rec: Record_,
  now: Date,
  settings?: AttendanceSettings,
): EffectiveStatus | null {
  if (!rec) return null;
  const s = settings || inputs.settings;
  if (rec.status !== "Present" && rec.status !== "WFH") return null;

  const open = isOpenPunch(rec);
  const worked = open ? 0 : computeWorkedHours(rec);
  const cls = classifyDay(inputs, rec.employeeId, rec.date, now, s);
  const classification = (cls && cls.classification) || rec.dayClassification || rec.status;
  const checkIn = rec.checkInTime && rec.checkInTime !== "-" ? rec.checkInTime : null;
  const checkOut = rec.checkOutTime && rec.checkOutTime !== "-" ? rec.checkOutTime : null;
  const isComplete = !open;

  // Lateness from shift start (+ grace), IST. Only flagged once grace is passed.
  const late: LateInfo = { isLate: false, minutes: 0, label: "On time" };
  const inM = parseClockToMinutes(checkIn);
  const startM = parseClockToMinutes(s.shiftStart);
  if (inM != null && startM != null) {
    const graceEnd = startM + (Number(s.graceMinutes) || 0);
    if (inM > graceEnd) {
      const from = s.lateFrom === "graceEnd" ? graceEnd : startM;
      const diff = inM - from;
      if (diff > 0) {
        late.isLate = true;
        late.minutes = diff;
        late.label = `-${formatMinutesHM(diff)} late`;
      }
    }
  }

  // Short-by for a completed day that fell under the required shift hours.
  const short: ShortInfo = { isShort: false, hours: 0, label: "" };
  if (isComplete && worked < s.requiredHours) {
    const shortMin = Math.round((s.requiredHours - worked) * 60);
    short.isShort = true;
    short.hours = Number((s.requiredHours - worked).toFixed(2));
    short.label = `Short by ${formatMinutesHM(shortMin)}`;
  }

  // Short-hours / override tags + reason.
  const tags: { label: string; reason: string }[] = [];
  if (classification && classification !== "Present" && classification !== "In Progress") {
    tags.push({ label: classification, reason: (cls && (cls as { reason?: string }).reason) || "" });
  }
  if (rec.overridePresent) tags.push({ label: "Admin Override", reason: rec.overrideReason || "" });

  return {
    status: rec.status,
    classification,
    isOpen: open,
    isComplete,
    checkIn,
    checkOut,
    workedHours: worked,
    late,
    short,
    tags,
    rec,
  };
}
