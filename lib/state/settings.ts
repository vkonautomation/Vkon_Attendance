/**
 * lib/state/settings.ts -- the policy the server reads before it decides anything.
 *
 * The geofence radius and accuracy gate, and the payroll cut-off the day status depends
 * on, are configuration, not constants. They live in the `settings` table (seeded by
 * db/seed/synthetic.sql, editable by an administrator) so a decision the server makes
 * reflects the current policy rather than a number frozen in a route handler -- which is
 * the whole reason coordinates are stored and the verdict is drawn at read time.
 *
 * Every getter has the outgoing backend's default as its fallback, so a database that has
 * not had the setting written yet behaves exactly as production does today rather than
 * throwing at the first punch.
 */

import { query } from "../db/pool";
import { config } from "../config";
import type { OfficePoint } from "../rules/geofence";

/** The portal's DEFAULT_SHORT_LEAVE_SETTINGS, restated as the fallback for a missing row. */
export interface AttendanceSettings {
  requiredHours: number;
  minPresentHours: number;
  payrollCutOffDay: number;
  shiftStart: string;
  graceMinutes: number;
  lateFrom: string;
  treatWeekendsAsNonWorking: boolean;
  holidayWorkMode: string;
}

const DEFAULT_ATTENDANCE: AttendanceSettings = {
  requiredHours: 9,
  minPresentHours: 8,
  payrollCutOffDay: 1,
  shiftStart: "09:30 AM",
  graceMinutes: 15,
  lateFrom: "shiftStart",
  treatWeekendsAsNonWorking: false,
  holidayWorkMode: "compoff",
};

const DEFAULT_OFFICE: OfficePoint & { name: string } = {
  name: "VKON Automation Tech Park",
  lat: 12.9716,
  lng: 77.5946,
  radiusMeters: 500,
};

/** Every settings row, as key -> parsed value. */
export async function readSettingsMap(): Promise<Record<string, unknown>> {
  const rows = await query<{ key: string; value: unknown }>("SELECT key, value FROM settings");
  const map: Record<string, unknown> = {};
  for (const r of rows) map[r.key] = r.value;
  return map;
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function num(v: unknown, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/** The fence the server draws, plus the accuracy gate. `settings` wins; else the default. */
export function geofenceContext(settings: Record<string, unknown>): {
  office: OfficePoint;
  maxTrustedAccuracyM: number;
} {
  const officeRaw = asRecord(settings["geofence.office"]);
  const office: OfficePoint = {
    lat: num(officeRaw.lat, DEFAULT_OFFICE.lat),
    lng: num(officeRaw.lng, DEFAULT_OFFICE.lng),
    radiusMeters: num(officeRaw.radiusMeters, DEFAULT_OFFICE.radiusMeters),
  };
  // The accuracy gate is only overridden per-deployment once HR signs the number off (Q4);
  // until then the operator knob (env) is the ceiling, defaulting to the old backend's.
  const maxTrusted = num(
    officeRaw.maxTrustedAccuracyM,
    config().geofence.defaultMaxTrustedAccuracyM,
  );
  return { office, maxTrustedAccuracyM: maxTrusted };
}

/** The shift policy the day rules read (payroll cut-off, short-hours floor). */
export function attendanceSettings(settings: Record<string, unknown>): AttendanceSettings {
  const raw = asRecord(settings["attendance.short_leave"]);
  const out: AttendanceSettings = { ...DEFAULT_ATTENDANCE };
  for (const k of Object.keys(DEFAULT_ATTENDANCE) as (keyof AttendanceSettings)[]) {
    if (raw[k] === undefined || raw[k] === null) continue;
    // Copy through: the stored value is already the coerced shape the rule expects.
    (out as unknown as Record<string, unknown>)[k] = raw[k];
  }
  return out;
}
