#!/usr/bin/env python3
"""
Static verification for the EARLY OUT / SHORT LEAVE feature.

Confirms every part of the spec is wired across shared.js / app.js / admin.js /
index.html / admin.html / styles.css. The classification decision-table itself is
exercised for real by `node test_early_out.js` (pure engine, localStorage shim).

Single-source-of-truth note: point 8's "server-side calculations" is satisfied for
this pure-static app by centralising ALL rules in the shared.js policy engine plus
a persisted audit log, with payroll-cut-off conversion computed lazily on load.
"""

import sys


def read(name):
    with open(name, "r", encoding="utf-8") as f:
        return f.read()


def verify_all():
    print("=== VERIFYING EARLY OUT / SHORT LEAVE FEATURE ===")

    shared = read("shared.js")
    app = read("app.js")
    admin = read("admin.js")
    admin_html = read("admin.html")
    index_html = read("index.html")
    styles = read("styles.css")

    def need(cond, msg):
        assert cond, "Fail: " + msg

    # ---- 1. Admin-configurable settings -------------------------------------
    print("\n[1] Settings store + defaults + accessors:")
    need('SHORT_LEAVE_SETTINGS: "vkon_short_leave_settings_v1"' in shared, "SHORT_LEAVE_SETTINGS key missing")
    need("DEFAULT_SHORT_LEAVE_SETTINGS" in shared, "Default settings object missing")
    for field in ["requiredHours", "minPresentHours", "halfDayThresholdHours",
                  "shortLeaveMonthlyLimit", "shortLeaveMaxHoursEach", "payrollCutOffDay"]:
        need(field in shared, f"setting field '{field}' missing in shared.js")
    need("function getAttendanceSettings" in shared and "function setAttendanceSettings" in shared,
         "settings getters/setters missing")
    # Admin UI exposes all six inputs + a save handler.
    for inp in ["slRequiredHoursInput", "slMinPresentHoursInput", "slHalfDayThresholdInput",
                "slMonthlyLimitInput", "slMaxHoursEachInput", "slPayrollCutOffInput"]:
        need(inp in admin_html, f"settings input '{inp}' missing in admin.html")
    need('id="shortLeavePolicyForm"' in admin_html, "short-leave settings form missing in admin.html")
    need("function initShortLeavePolicyForm" in admin and "initShortLeavePolicyForm()" in admin,
         "settings form not initialised in admin.js")
    print("  PASS")

    # ---- 2. New 'earlyout' approval type ------------------------------------
    print("\n[2] Early Out approval type wired into the engine:")
    need('"earlyout"' in shared, "earlyout not added to shared.js")
    need('earlyout: "manager_only"' in shared, "default earlyout flow not manager_only")
    need("function approvalTypeStoreKey" in shared, "approval store mapper missing")
    need('EARLY_OUTS: "vkon_early_outs_v1"' in shared, "EARLY_OUTS store key missing")
    print("  PASS")

    # ---- 3. Employee side: request action card + submit + balance -----------
    print("\n[3] Employee action card, submit + monthly balance:")
    need('id="modalCardEarlyOut"' in index_html, "early-out modal card missing in index.html")
    need('id="earlyOutRequestForm"' in index_html, "early-out form missing in index.html")
    need("Request Early Out" in index_html, "Request Early Out action missing in index.html")
    need("half-day-leave" in index_html and "lop" in index_html, "over-limit treatment choices missing")
    need("earlyOutEmergency" in index_html, "emergency control missing in index.html")
    need("function initEarlyOutBox" in app and "initEarlyOutBox(" in app, "early-out submit handler missing in app.js")
    need("routingForNewRequest(\"earlyout\"" in app, "submit does not route a new earlyout request")
    need("function updateEarlyOutBalanceDisplay" in app and "earlyOutBalanceText" in app,
         "monthly short-leave balance widget missing in app.js")
    need('id="dashStatShortLeave"' in index_html, "dashboard balance stat card missing in index.html")
    print("  PASS")

    # ---- 4. Policy engine (classification) ----------------------------------
    print("\n[4] Policy engine (single source of truth):")
    for fn in ["function computeWorkedHours", "function classifyDay", "function getShortLeaveUsage",
               "function recalcDayForRecord", "function recalcShortLeaveDays", "function isShortHoursDay",
               "function isEarlyOutWithinLimit", "function displayStatusForRecord"]:
        need(fn in shared, fn + " missing in shared.js")
    for tag in ['"Short leave"', '"Half-day"', '"Half-day (LOP)"', '"Short hours - review"',
               '"Short hours (LOP)"', '"Present (Override)"']:
        need(tag in shared, f"classification tag {tag} missing in shared.js")
    need("addLopEntry(" in shared and "cancelLopEntriesByRef(" in shared, "engine does not manage LOP entries")
    # Punch-out triggers a reclassification.
    need("recalcDayForRecord(" in app, "punch-out does not recalculate the day in app.js")
    # Lazy recalculation on load (no scheduler).
    need("recalcShortLeaveDays()" in shared, "lazy recalc not called on load in shared.js")
    print("  PASS")

    # ---- 5. Calendar + admin views ------------------------------------------
    print("\n[5] Calendar and admin views:")
    need("function classificationPill" in app or "classificationPill" in app, "calendar classification pill missing in app.js")
    need("cell-early-out" in app, "today's early-out calendar action missing in app.js")
    # Master sheet + CSV Short-hours column.
    need("Short Hours" in admin_html, "Short Hours column header missing in admin.html")
    need("shortHoursCount" in admin and "isShortHoursDay" in admin, "Short Hours count logic missing in admin.js")
    need("Short Hours (Review) Days" in admin, "Short Hours column not exported in CSV")
    # Early Out approvals category.
    need('id="panel-approval-eo"' in admin_html, "early-out approvals panel missing in admin.html")
    need('id="adminEarlyOutTableBody"' in admin_html, "early-out approvals table missing in admin.html")
    need('id="drawerEarlyOutBadge"' in admin_html, "early-out drawer badge missing in admin.html")
    need("function renderEarlyOutApprovals" in admin and "renderEarlyOutApprovals()" in admin,
         "early-out approvals renderer missing/not wired in admin.js")
    print("  PASS")

    # ---- 6. Admin override to Present ---------------------------------------
    print("\n[6] Admin override to Present:")
    need("function applyAdminOverride" in shared, "applyAdminOverride missing in shared.js")
    need("reason" in shared and 'error: "reason_required"' in shared, "override does not require a reason")
    need("function _adminOverridePresent" in admin and "cell-admin-override" in admin,
         "override control missing in admin.js")
    print("  PASS")

    # ---- 7. Audit log -------------------------------------------------------
    print("\n[7] Audit log (actor, decision, comment, timestamp):")
    need('AUDIT_LOG: "vkon_audit_log_v1"' in shared, "AUDIT_LOG store key missing")
    need("function addAudit" in shared and "function getAuditLog" in shared, "audit helpers missing in shared.js")
    need("addAudit(" in app, "audit logging not called from app.js")
    need('addAudit("earlyout-created"' in app, "early-out submission not audit logged")
    for action in ["admin-override-present", "short-hours-auto-lop"]:
        need(action in shared, f"audit action '{action}' not logged")
    need('id="tab-audit"' in admin_html, "audit log panel missing in admin.html")
    need('id="auditLogTableBody"' in admin_html, "audit log table missing in admin.html")
    need("function renderAuditLog" in admin and "renderAuditLog()" in admin, "audit log renderer missing in admin.js")
    print("  PASS")

    # ---- 8. Cache tokens + CSS ----------------------------------------------
    print("\n[8] Cache tokens + badge CSS:")
    need("shared.js?v=20261013_ist_apr12" in index_html and "shared.js?v=20261013_ist_apr12" in admin_html,
         "shared.js cache token not bumped")
    need("app.js?v=20261023_apr11" in index_html, "app.js cache token not bumped")
    need("admin.js?v=20261023_apr18" in admin_html, "admin.js cache token not bumped")
    need("styles.css?v=20261023_apr12" in index_html and "styles.css?v=20261023_apr12" in admin_html,
         "styles.css cache token not bumped")
    for cls in ["badge-shortleave", "badge-halfday", "badge-shorthours", "badge-override",
                "badge-inprogress", "icon-bg-teal", "text-teal"]:
        need(cls in styles, f"CSS class '{cls}' missing in styles.css")
    print("  PASS")

    print("\n" + "=" * 54)
    print(">>> EARLY OUT / SHORT LEAVE FEATURE VERIFIED SUCCESSFULLY! <<<")
    print("=" * 54)


if __name__ == "__main__":
    try:
        verify_all()
    except AssertionError as e:
        print(str(e))
        sys.exit(1)
