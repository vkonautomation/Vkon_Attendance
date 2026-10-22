#!/usr/bin/env python3
"""
Static verification for the Loss of Pay (LOP) + Payroll integration.
Checks that every rule in the spec is wired across shared.js / admin.js /
app.js / admin.html / index.html / styles.css. The pure money math is exercised
separately by `node test_lop_payroll.js` (see the numeric assertions there).
"""

import sys

def read(name):
    with open(name, "r", encoding="utf-8") as f:
        return f.read()

def verify_all():
    print("=== VERIFYING LOSS OF PAY + PAYROLL MODULE ===")

    shared = read("shared.js")
    admin = read("admin.js")
    app = read("app.js")
    admin_html = read("admin.html")
    index_html = read("index.html")
    styles = read("styles.css")

    def need(cond, msg):
        assert cond, "Fail: " + msg

    # Rule 1: per-day rate = gross / divisor (configurable: fixed30 | calendar | working)
    print("\n[Rule 1] Per-day rate + configurable divisor:")
    need("function lopDivisorValue" in shared, "lopDivisorValue missing")
    need('"fixed30"' in shared and '"calendar"' in shared and '"working"' in shared, "divisor modes missing")
    need("function computePerDayRate" in shared or "function perDayRateRaw" in shared, "per-day-rate helper missing")
    need("lopDivisorMode" in admin_html, "divisor select missing in admin.html")
    print("  PASS")

    # Rule 2: deduction = per_day_rate * lop days; net = gross - lop - other; round 2 dp
    print("\n[Rule 2] Deduction, net & rounding:")
    need("function computeLopDeduction" in shared, "computeLopDeduction missing")
    need("function round2" in shared and "function money2" in shared, "money rounding helpers missing")
    need("gross - lopAmount - other" in shared, "net formula missing")
    print("  PASS")

    # Rule 3: what counts as LOP (approved LOP leave / excess / absent convert)
    print("\n[Rule 3] LOP day sources (a/b/c):")
    need("function createLopEntriesForLeave" in shared, "LOP leave entry creator missing")
    need('source !== "leave"' in shared or '"excess"' in shared, "excess source missing")
    need('"excess"' in admin, "paid-balance overflow -> LOP not wired in admin.js")
    need("convertAbsentsToLop" in admin, "absent -> LOP conversion missing")
    print("  PASS")

    # Rule 4: half-day LOP (0.5)
    print("\n[Rule 4] Half-day LOP:")
    need("halfDay" in shared and "0.5" in shared, "half-day handling missing in shared.js")
    need("lopHalfDay" in index_html and "lopHalfDay" in app, "half-day control missing in portal")
    print("  PASS")

    # Rule 5: sandwich rule toggle
    print("\n[Rule 5] Sandwich rule:")
    need("sandwichRule" in shared, "sandwich rule missing in shared.js")
    need("lopSandwichRule" in admin_html, "sandwich toggle missing in admin.html")
    print("  PASS")

    # Rule 6: pro-rate mid-month joiners/leavers, then LOP
    print("\n[Rule 6] Pro-rate:")
    need("function prorateGross" in shared, "prorateGross missing")
    need("prorateGross(" in admin, "pro-rate not applied in payroll line")
    print("  PASS")

    # Rule 7: payroll lock OPEN -> LOCKED -> PAID; override reason; credit adjustment
    print("\n[Rule 7] Payroll lock lifecycle + credit:")
    need('PAYROLL_STATUSES = ["OPEN", "LOCKED", "PAID"]' in shared, "payroll statuses missing")
    need("lockPayrollMonth" in admin and "unlockPayrollMonth" in admin and "markPayrollPaid" in admin, "lock handlers missing")
    need("prompt(" in admin, "override reason prompt missing")
    need("function addLopCredit" in admin and "addLopCredit(" in admin, "credit adjustment missing")
    print("  PASS")

    # Rule 8: snapshot on each payroll line
    print("\n[Rule 8] Payslip snapshot:")
    need("function setPayrollLine" in shared and "snapshotAt" in shared, "payroll line snapshot missing")
    need("snapshotPayrollMonth" in admin, "month snapshot on lock missing")
    print("  PASS")

    # Rule 9: audit log for create/approve/cancel/reverse (+convert/lock/pay)
    print("\n[Rule 9] Audit log:")
    need("function logLopAction" in shared and "AUDIT_LOG" in shared, "audit log helper missing")
    for act in ["approve", "cancel", "reverse", "lock", "pay", "convert"]:
        need(f'logLopAction("{act}"' in admin, f'audit action "{act}" missing')
    need("renderAuditLog" in admin and "lopAuditLog" in admin_html, "audit log view missing")
    print("  PASS")

    # Data model keys
    print("\n[Data model] salary_structure / payroll_runs / payroll_lines / audit_log / lop entries:")
    for k in ["SALARY_STRUCTURE", "PAYROLL_RUNS", "PAYROLL_LINES", "AUDIT_LOG", "LOP_ENTRIES", "LOP_SETTINGS"]:
        need(k in shared, k + " storage key missing")
    print("  PASS")

    # UI surfaces
    print("\n[UI] form estimate, dashboard, approvals, calendar, payroll page:")
    need("estimateLopDeduction" in app, "employee estimated deduction missing in app.js")
    need("warning-box-lop" in app, "employee LOP confirmation warning missing")
    need("statsLopCount" in app and "dot-lop" in index_html, "dashboard LOP stat / legend missing")
    need("lop-est-note" in admin, "admin approval estimate missing")
    need("payrollTableBody" in admin_html and "LOP Deduction" in admin_html, "payroll page columns missing in admin.html")
    need("exportPayrollCsv" in admin and "Export CSV" in admin, "payroll CSV export missing")
    need("badge-lop-day" in app, "calendar LOP colour missing")
    print("  PASS")

    # CSS layer present
    print("\n[CSS] v9.0 layer:")
    for sel in ["payroll-summary", "pay-status-locked", "lop-days-pill", "audit-row", "warning-box-lop"]:
        need(sel in styles, sel + " CSS missing")
    print("  PASS")

    print("\n" + "=" * 54)
    print(">>> LOSS OF PAY + PAYROLL MODULE VERIFIED SUCCESSFULLY! <<<")
    print("=" * 54)

if __name__ == "__main__":
    try:
        verify_all()
    except AssertionError as e:
        print(str(e))
        sys.exit(1)
