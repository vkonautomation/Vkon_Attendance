/**
 * lib/rules/types.ts -- the shapes the pure rule functions read.
 *
 * These mirror the browser's stored documents (public/shared.js reads them out of
 * localStorage under the `vkon_*` keys), but the rule functions themselves take them as
 * explicit arguments rather than reaching for a store. That is the whole point of the
 * extraction (D2): a rule is a function of its inputs, so the server, the browser and the
 * conformance harness can all feed the SAME inputs and be held to the SAME output. The
 * projection layer (M6) is what turns database rows into these shapes.
 *
 * Field names stay camelCase and keep the browser's spellings ("Present", "Restricted
 * Holiday", `checkInTime: "09:31 AM"`) on purpose: a conformance harness can only compare
 * two implementations against identical inputs, and re-spelling the inputs is how you get
 * a green harness that proves nothing.
 */

export type DayStatus =
  | "Present"
  | "Absent"
  | "Leave"
  | "WFH"
  | "Holiday"
  | "Loss of Pay"
  | string;

export interface Employee {
  id: string;
  name?: string;
  department?: string;
  monthlySalary?: number;
  customLeaveQuota?: number | string | null;
  customRhQuota?: number | string | null;
  enrolledAt?: string | null;
  managerId?: string | null;
}

export interface Record_ {
  employeeId: string;
  date: string; // YYYY-MM-DD
  status: DayStatus;
  checkInTime?: string | null; // "09:31 AM"
  checkOutTime?: string | null; // "06:05 PM" or "-"
  hoursDecimal?: number;
  locationType?: string | null;
  overridePresent?: boolean;
  overrideReason?: string | null;
  dayClassification?: string | null;
  workedHours?: number;
  [k: string]: unknown;
}

export interface LeaveRequest {
  employeeId: string;
  status: string; // "Approved" | "Pending Manager" | ...
  category?: string;
  type?: string;
  date?: string;
  startDate?: string;
  endDate?: string;
  daysCount?: number | string;
  [k: string]: unknown;
}

export interface WfhRequest {
  employeeId: string;
  status: string;
  date?: string;
  weekKey?: string;
  startDate?: string;
  endDate?: string;
  [k: string]: unknown;
}

export interface Regularisation {
  employeeId: string;
  date: string;
  status: string;
  [k: string]: unknown;
}

export interface Holiday {
  date: string;
  type: string; // "Declared Holiday" | "Restricted Holiday"
  name?: string;
  [k: string]: unknown;
}

export interface LopEntry {
  employeeId: string;
  date: string;
  fraction?: number;
  source?: string;
  refId?: string | null;
  status: "active" | "cancelled" | string;
}

export interface AttendanceSettings {
  requiredHours: number;
  minPresentHours: number;
  payrollCutOffDay: number;
  shiftStart: string;
  graceMinutes: number;
  lateFrom: "shiftStart" | "graceEnd";
  treatWeekendsAsNonWorking: boolean;
  holidayWorkMode: "compoff" | "extrapay";
}

export interface GlobalLeaveQuotas {
  personalLeave: number;
  restrictedLeave: number;
}

/** Every document a rule might need, in one explicit input bundle. */
export interface RuleInputs {
  employees: Employee[];
  records: Record<string, Record_>; // keyed `${employeeId}_${date}`
  leaves: LeaveRequest[];
  wfh: WfhRequest[];
  regularisations: Regularisation[];
  holidays: Holiday[];
  lopEntries: LopEntry[];
  holidayWork: Record<string, unknown>; // keyed `${employeeId}_${date}`
  settings: AttendanceSettings;
  globalQuotas: GlobalLeaveQuotas;
}

/**
 * The defaults public/shared.js applies when a store key is empty, reproduced here so the
 * server's notion of "no settings saved" is byte-identical to the browser's.
 */
export const DEFAULT_SETTINGS: AttendanceSettings = {
  requiredHours: 9,
  minPresentHours: 8,
  payrollCutOffDay: 1,
  shiftStart: "09:30 AM",
  graceMinutes: 15,
  lateFrom: "shiftStart",
  treatWeekendsAsNonWorking: false,
  holidayWorkMode: "compoff",
};

export const DEFAULT_GLOBAL_QUOTAS: GlobalLeaveQuotas = { personalLeave: 14, restrictedLeave: 2 };

/** A RuleInputs with empty collections -- the fixture base each case overrides. */
export function emptyInputs(): RuleInputs {
  return {
    employees: [],
    records: {},
    leaves: [],
    wfh: [],
    regularisations: [],
    holidays: [],
    lopEntries: [],
    holidayWork: {},
    settings: { ...DEFAULT_SETTINGS },
    globalQuotas: { ...DEFAULT_GLOBAL_QUOTAS },
  };
}
