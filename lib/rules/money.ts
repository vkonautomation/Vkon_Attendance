/**
 * lib/rules/money.ts -- LOP arithmetic, the place a rounding difference becomes money.
 *
 * Ported verbatim from public/shared.js (computeLopDeduction / round2 / money2 /
 * perDayRateRaw). The one rule that must not drift: the per-day rate is kept UNROUNDED
 * while it is multiplied, and rounded only at the end -- so (50000 / 30) * 3 is exactly
 * 5000.00, not 1666.67 * 3 = 5000.01. Rounding the per-day figure first is the classic
 * payroll bug, and it is the first thing the conformance harness pins down.
 */

export const LOP_PER_DAY_DIVISOR = 30;

/** Two-decimal half-up rounding, with the epsilon guard that keeps 1.005 -> 1.01 stable. */
export function round2(n: number): number {
  const v = Number(n) || 0;
  return Math.round((v + Number.EPSILON) * 100) / 100;
}

/** The rounded number as a fixed-2 string, for display and for the audit trail. */
export function money2(n: number): string {
  return round2(n).toFixed(2);
}

/** UNROUNDED per-day salary: deliberately full precision, consumed by the multiply step. */
export function perDayRateRaw(monthlySalary: number): number {
  return (Number(monthlySalary) || 0) / LOP_PER_DAY_DIVISOR;
}

export interface LopDeductionInput {
  monthlySalary?: number;
  monthlyGross?: number;
  lopDays?: number;
  otherDeductions?: number;
}

export interface LopDeduction {
  gross: number;
  perDaySalary: number;
  lopDays: number;
  lopAmount: number;
  otherDeductions: number;
  net: number;
}

/**
 * Core deduction. `perDaySalary` in the result is the ROUNDED figure for display; the
 * deduction itself uses the unrounded rate so the multiply stays exact.
 */
export function computeLopDeduction(opts: LopDeductionInput): LopDeduction {
  const gross = Number(opts.monthlySalary != null ? opts.monthlySalary : opts.monthlyGross) || 0;
  const raw = perDayRateRaw(gross);
  const lopDays = Number(opts.lopDays) || 0;
  const lopAmount = round2(raw * lopDays);
  const other = Number(opts.otherDeductions) || 0;
  const net = round2(gross - lopAmount - other);
  return {
    gross: round2(gross),
    perDaySalary: round2(raw),
    lopDays,
    lopAmount,
    otherDeductions: round2(other),
    net,
  };
}

/**
 * The per-employee estimate the portal shows before a request is filed. The salary comes
 * from the roster: an explicit monthly_salary if set, else the department default, else a
 * floor -- exactly the fallback chain employeeMonthlySalary() uses.
 */
export const DEPT_DEFAULT_SALARY: Record<string, number> = {
  Engineering: 85000,
  Product: 78000,
  Operations: 92000,
  Infrastructure: 88000,
};

export function monthlySalaryFor(
  emp: { monthlySalary?: number; department?: string } | undefined,
): number {
  if (!emp) return 0;
  const ms = Number(emp.monthlySalary);
  if (ms > 0) return ms;
  return DEPT_DEFAULT_SALARY[emp.department as string] || 70000;
}

export function estimateLopDeduction(
  emp: { monthlySalary?: number; department?: string } | undefined,
  lopDays: number,
): { perDaySalary: number; amount: number } {
  const salary = monthlySalaryFor(emp);
  const raw = perDayRateRaw(salary);
  return { perDaySalary: round2(raw), amount: round2(raw * (Number(lopDays) || 0)) };
}
