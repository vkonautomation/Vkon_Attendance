#!/usr/bin/env python3
"""
Static verification for the BASIC Loss of Pay (LOP) feature.
Checks that every requirement in the spec is wired across shared.js / admin.js /
app.js / admin.html / index.html / styles.css. The pure money math is exercised
separately by `node test_lop_payroll.js` (see the numeric assertions there).

It also asserts the explicitly-deferred items are NOT present yet: payroll
locking, the sandwich rule, mid-month pro-rating, absent auto-conversion and
the audit log.
"""

import sys

def read(name):
    with open("public/" + name, "r", encoding="utf-8") as f:
        return f.read()

def verify_all():
    print("=== VERIFYING BASIC LOSS OF PAY FEATURE ===")

    shared = read("shared.js")
    admin = read("admin.js")
    app = read("app.js")
    admin_html = read("admin.html")
    index_html = read("index.html")
    styles = read("styles.css")

    def need(cond, msg):
        assert cond, "Fail: " + msg

    # Req 1: monthly_salary field on the employee record, admin-editable.
    print("\n[Req 1] monthly_salary field (admin-editable):")
    need("monthlySalary:" in shared, "monthlySalary field missing on employee records")
    need("function employeeMonthlySalary" in shared, "employeeMonthlySalary accessor missing")
    need("function setEmployeeMonthlySalary" in shared, "salary setter missing")
    need("pay-salary-input" in admin and "setEmployeeMonthlySalary(" in admin, "salary not editable in admin console")
    print("  PASS")

    # Req 2: LOP leave type (whole-day only; the half-day / 0.5 LOP was removed).
    print("\n[Req 2] LOP leave type (whole-day only):")
    need("LossOfPay" in index_html and "Loss of Pay" in index_html, "LOP option missing on leave form")
    need("lopHalfDay" not in index_html and "lopHalfDay" not in app, "half-day control should be removed from the portal")
    need("halfDay" not in shared, "half-day (0.5) LOP handling should be removed from shared.js")
    need("fraction: 1" in shared, "LOP entries should always be whole-day (fraction 1)")
    print("  PASS")

    # Req 3: per_day = monthly_salary / 30; deduction; net; round 2 dp.
    print("\n[Req 3] Calculation (per-day / 30, deduction, net, 2 dp):")
    need("LOP_PER_DAY_DIVISOR = 30" in shared, "divisor 30 constant missing")
    need("function perDayRateRaw" in shared and "/ LOP_PER_DAY_DIVISOR" in shared, "per-day salary helper missing")
    need("function computeLopDeduction" in shared, "computeLopDeduction missing")
    need("gross - lopAmount - other" in shared, "net formula missing")
    need("function round2" in shared and "function money2" in shared, "money rounding helpers missing")
    print("  PASS")

    # Req 4: LOP counts when approved LOP leave (a) or paid-balance excess (b).
    print("\n[Req 4] LOP day sources (approved leave / paid-balance excess):")
    need("function createLopEntriesForLeave" in shared, "LOP leave entry creator missing")
    need('req.status !== "Approved"' in shared, "approved-only gate missing on entry creation")
    # The paid-balance overflow -> LOP wiring now lives in the shared.js approval
    # engine (applyApprovedEffect), applied only on final approval.
    need("'excess'" in shared or '"excess"' in shared, "paid-balance overflow -> LOP not wired in shared.js")
    need("getEmployeeLeaveQuota" in shared and "applyApprovedEffect" in shared, "paid-balance overflow not applied at final approval")
    print("  PASS")

    # Req 5: employee form shows estimated deduction before submitting.
    print("\n[Req 5] Employee form estimate:")
    need("estimateLopDeduction" in app, "employee estimated deduction missing in app.js")
    need("Estimated deduction" in app, "estimate wording missing in app.js")
    need("warning-box-lop" in app, "employee LOP confirmation warning missing")
    print("  PASS")

    # Req 6: admin approvals show the estimated deduction.
    print("\n[Req 6] Admin approvals estimate:")
    need("Est. deduction" in admin, "admin approval estimate missing")
    need("lop-est-note" in admin, "admin estimate note markup missing")
    print("  PASS")

    # Req 7: payroll page monthly table + CSV export.
    print("\n[Req 7] Payroll page + CSV export:")
    need("payrollTableBody" in admin_html, "payroll table missing in admin.html")
    for col in ["Monthly Salary", "LOP Days", "LOP Deduction", "Net Salary"]:
        need(col in admin_html, f"payroll column '{col}' missing in admin.html")
    need("exportPayrollCsv" in admin and "Export CSV" in admin, "payroll CSV export missing")
    print("  PASS")

    # Req 8: calendar LOP status colour + legend.
    print("\n[Req 8] Calendar LOP colour + legend:")
    need("badge-lop-day" in app, "calendar LOP colour missing in app.js")
    need("dot-lop" in index_html, "calendar LOP legend entry missing in index.html")
    print("  PASS")

    # Req 9: only approved requests count (rejected/cancelled reversed).
    print("\n[Req 9] Only approved count:")
    need("cancelLopEntriesByRef" in shared, "LOP reversal on cancellation missing")
    need("cancelLopEntriesByRef(req.id)" in shared, "cancellation not wired to reverse LOP in shared.js engine")
    need('e.status === "active"' in shared, "active-only day filter missing in shared.js")
    print("  PASS")

    # Data model: lop entries store + monthlySalary on employees.
    print("\n[Data model] LOP entries store + employee salary:")
    for k in ["LOP_ENTRIES"]:
        need(k in shared, k + " storage key missing")
    need("vkon_lop_entries_v1" in shared, "LOP entries key literal missing")
    print("  PASS")

    # Deferred items must NOT be built yet.
    print("\n[Deferred] locking / sandwich / pro-rate / auto-convert absent:")
    for absent in ["lopDivisorValue", "prorateGross", "getLopSettings", "setLopSettings",
                   "PAYROLL_STATUSES", "lockPayrollMonth", "addLopCredit", "logLopAction",
                   "SANDWICH", "sandwichRule"]:
        need(absent not in shared and absent not in admin, f"deferred symbol '{absent}' should not be built yet")
    need("lopSettingsForm" not in admin_html and "lopSandwichRule" not in admin_html, "deferred LOP settings UI present")
    need("lopAuditLog" not in admin_html, "deferred LOP audit log UI present")
    print("  PASS")

    # CSS layer present.
    print("\n[CSS] v9.0 LOP layer:")
    for sel in ["payroll-summary", "lop-days-pill", "warning-box-lop", "lop-est-note", "badge-lop-day"]:
        need(sel in styles, sel + " CSS missing")
    print("  PASS")

    print("\n" + "=" * 54)
    print(">>> BASIC LOSS OF PAY FEATURE VERIFIED SUCCESSFULLY! <<<")
    print("=" * 54)

if __name__ == "__main__":
    try:
        verify_all()
    except AssertionError as e:
        print(str(e))
        sys.exit(1)
