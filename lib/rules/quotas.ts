/**
 * lib/rules/quotas.ts -- leave quota arithmetic (Personal annual, Restricted monthly).
 *
 * Ported verbatim from public/shared.js. Two rules that are easy to get subtly wrong and
 * that change the number an employee sees:
 *   - Only APPROVED leave counts as "used"; a pending request is not yet spent. And Loss of
 *     Pay is unpaid by choice, so it NEVER touches a paid-leave quota -- hence the explicit
 *     category !== "LossOfPay" / "Loss of Pay" exclusions on both personal and total paths.
 *   - Restricted (RH) leave has its own MONTHLY allowance and must not be counted against
 *     the ANNUAL personal quota; personal is whole-year, restricted is per-month. Mixing
 *     the windows is how someone runs out of personal leave they never took.
 */

import type { RuleInputs, LeaveRequest } from "./types";

export interface EmployeeQuota {
  personalLeave: number;
  restrictedLeave: number;
  isOverridden?: boolean;
}

function hasCustom(v: unknown): boolean {
  return v !== undefined && v !== null && (v as string) !== "";
}

/** The effective quota for one employee: per-employee override else company default. */
export function employeeLeaveQuota(inputs: RuleInputs, empId: string): EmployeeQuota {
  const globalQ = inputs.globalQuotas;
  const emp = inputs.employees.find((e) => e.id === empId);
  // A missing employee gets the bare company default, with NO isOverridden flag -- exactly
  // what shared.js's getEmployeeLeaveQuota returns (`return globalQ`). The harness compares
  // whole objects, so reproducing that shape (2 keys, not 3) is part of conformance.
  if (!emp) return { personalLeave: globalQ.personalLeave, restrictedLeave: globalQ.restrictedLeave };

  const personal = hasCustom(emp.customLeaveQuota) ? Number(emp.customLeaveQuota) : globalQ.personalLeave;
  const restricted = hasCustom(emp.customRhQuota) ? Number(emp.customRhQuota) : globalQ.restrictedLeave;

  return {
    personalLeave: personal,
    restrictedLeave: restricted,
    isOverridden: hasCustom(emp.customLeaveQuota) || hasCustom(emp.customRhQuota),
  };
}

export function isRestrictedLeave(l: LeaveRequest): boolean {
  return l.category === "Restricted" || l.category === "RH" || (l.type || "").indexOf("Restricted") !== -1;
}

export function isPersonalLeave(l: LeaveRequest): boolean {
  return !isRestrictedLeave(l) && l.category !== "LossOfPay" && (l.type || "").indexOf("Loss of Pay") === -1;
}

/** Approved (non-LOP) leave days used across the year -- the shared "used" total. */
export function approvedLeaveDaysUsed(inputs: RuleInputs, empId: string): number {
  return inputs.leaves
    .filter((l) => l.employeeId === empId && l.status === "Approved" && l.category !== "LossOfPay")
    .reduce((sum, l) => sum + (parseInt(String(l.daysCount), 10) || 1), 0);
}

/** Approved PERSONAL leave days used across the whole year (annual paid quota). */
export function approvedPersonalLeaveDaysUsed(inputs: RuleInputs, empId: string): number {
  return inputs.leaves
    .filter((l) => l.employeeId === empId && l.status === "Approved" && isPersonalLeave(l))
    .reduce((sum, l) => sum + (parseFloat(String(l.daysCount)) || 1), 0);
}

/** Approved RESTRICTED (RH) leave days used within a specific month (monthly allowance). */
export function approvedRestrictedLeaveDaysInMonth(
  inputs: RuleInputs,
  empId: string,
  year: number,
  month: number,
): number {
  return inputs.leaves
    .filter((l) => {
      if (l.employeeId !== empId || l.status !== "Approved" || !isRestrictedLeave(l)) return false;
      const d = new Date((l.startDate || "") + "T00:00:00");
      return d.getFullYear() === year && d.getMonth() === month;
    })
    .reduce((sum, l) => sum + (parseFloat(String(l.daysCount)) || 1), 0);
}
