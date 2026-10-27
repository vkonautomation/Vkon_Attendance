#!/usr/bin/env python3
"""
Static verification for the HIDE PUNCHING ON DECLARED HOLIDAYS feature.

Confirms the single shared isNonWorkingDay() rule is used by every screen
(employee dashboard, both calendars, the admin counts), that the punch write
path itself rejects holiday punches (so hiding the buttons cannot be bypassed),
that holidays are excluded from the Absent / Not-Marked / Late / elapsed counts,
that an Admin "Worked on holiday" override (with a required reason + audit)
reopens punching for one employee + date, that restricted holidays honour the
approved-leave rule, and that holiday add/remove keeps existing punches and
warns the admin.

The rule itself (isNonWorkingDay / punch gate / override / restricted leave /
weekend setting / next-working-day) is exercised for real by
`node test_holiday_gate.js` (pure engine, localStorage shim).
"""

import sys


def read(name):
    with open(name, "r", encoding="utf-8") as f:
        return f.read()


def verify_all():
    print("=== VERIFYING HOLIDAY PUNCH-HIDING (9 REQUIREMENTS) ===")

    shared = read("shared.js")
    app = read("app.js")
    admin = read("admin.js")
    admin_html = read("admin.html")
    index_html = read("index.html")
    styles = read("styles.css")

    def need(cond, msg):
        assert cond, "Fail: " + msg

    # ---- 1. One shared function used everywhere ----------------------------
    print("\n[1] shared.js isNonWorkingDay() single source of truth:")
    need("function isNonWorkingDay" in shared, "isNonWorkingDay missing in shared.js")
    need("function findHolidayForDate" in shared, "findHolidayForDate helper missing")
    need("function punchBlockedReason" in shared, "punchBlockedReason gate missing")
    need("function getNextWorkingDay" in shared, "getNextWorkingDay missing")
    # reads the Holidays store + optional weekend setting
    need("STORAGE_KEYS.HOLIDAYS" in shared, "isNonWorkingDay does not read the Holidays list")
    need("treatWeekendsAsNonWorking" in shared, "weekend-by-setting option missing")
    print("  PASS")

    # ---- 2. Employee dashboard holiday card --------------------------------
    print("\n[2] Employee dashboard holiday card (req 2):")
    need("holidayTodayCard" in index_html, "holiday card markup missing in index.html")
    need("holidayTodayName" in index_html, "holiday name slot missing")
    need("holidayTodayNext" in index_html, "next-working-day slot missing")
    need("isNonWorkingDay" in app, "app.js dashboard does not use shared rule")
    need("holidayTodayCard" in app, "app.js does not reveal the holiday card")
    need("No check-in needed" in app, "holiday message text missing")
    need("getNextWorkingDay" in app, "next working day not computed on dashboard")
    # punch card / status are hidden on a holiday
    need("mark-present-bar-wrapper" in app and "todayStatusBadge" in app,
         "dashboard does not hide the Mark Present bar / status badge")
    print("  PASS")

    # ---- 3. Punch actions rejected server-side -----------------------------
    print("\n[3] Punch write path rejects holiday punches (req 3):")
    # the reject guard must live in the confirm/punch write path, not just the UI
    need("punchBlockedReason" in app, "punch service gate missing in app.js")
    need("handleConfirmVerification" in app, "confirm/punch handler not found")
    assert app.index("function handleConfirmVerification") < app.index(
        "punchBlockedReason(employeeState.currentEmployee.id"), \
        "punch reject guard is not at the top of handleConfirmVerification"
    need("Punch rejected" in app, "explicit punch-rejected message missing")
    print("  PASS")

    # ---- 4. Calendar holiday cell + popover --------------------------------
    print("\n[4] Calendars show holiday-only cells (req 4):")
    need("isNonWorkingDay" in admin or "workedOnHoliday" in admin,
         "admin calendar does not use the shared holiday rule")
    need("declaredHoliday" in app and "declaredHoliday" in admin,
         "holiday chip not rendered on both calendars")
    print("  PASS")

    # ---- 5. Exclusions from counts -----------------------------------------
    print("\n[5] Holiday exclusions from counts (req 5):")
    # master sheet must skip holiday before counting elapsed / not-marked
    assert "isNonWorkingDay(dateStr, emp.id)" in admin or "isNonWorkingDay(dateStr,emp.id)" in admin.replace(" ", ""), \
        "admin master sheet does not skip holidays when counting"
    # the holiday branch must `continue` BEFORE any of the short/LOP/absent/unmarked
    # counters are touched, so a holiday is excluded from every one of them.
    need("empWorkingDaysElapsed" in admin, "working-days-elapsed counter missing")
    need("lopCount" in admin, "LOP counter not found to exclude")
    need("shortHoursCount" in admin, "short-hours counter not found to exclude")
    need("unmarkedCount" in admin, "not-marked counter not found to exclude")
    _skip_at = admin.index("if (isNonWorking)")
    _cont_at = admin.index("continue;", _skip_at)
    for _cnt in ["shortHoursCount++", "lopCount++", "unmarkedCount++", "absentCount++", "empWorkingDaysElapsed++"]:
        need(_skip_at < admin.index(_cnt), f"'{_cnt}' is counted before the holiday skip")
        need(_cont_at < admin.index(_cnt), f"'{_cnt}' is counted before the holiday continue")
    need('todayStatus = "holiday"' in admin or "pill-holiday" in admin,
         "holiday not surfaced as its own today-status (excluded from not-in/late)")
    print("  PASS")

    # ---- 6. Worked-on-holiday override -------------------------------------
    print("\n[6] Worked-on-holiday exception (req 6):")
    need("function markWorkedOnHoliday" in shared, "markWorkedOnHoliday missing")
    need("function clearWorkedOnHoliday" in shared, "clearWorkedOnHoliday missing")
    need("isWorkedOnHoliday" in shared,
         "override not consulted by the engine")
    need("STORAGE_KEYS.HOLIDAY_WORK" in shared, "override store key not wired")
    need("_adminMarkWorkedOnHoliday" in admin, "admin override control missing")
    need("reasonRequired" in admin and "hwModeSelect" in admin,
         "override requires a reason + comp-off/extra-pay choice")
    need("cell-holiday-work" in admin, "in-cell Worked-on-holiday control missing")
    # holidayWorkMode setting is configurable
    need("holidayWorkMode" in shared, "holidayWorkMode policy setting missing")
    print("  PASS")

    # ---- 7. Restricted holiday honours approved leave ----------------------
    print("\n[7] Restricted holidays (req 7):")
    need("function hasApprovedRestrictedLeaveOnDate" in shared,
         "restricted-leave approval check missing")
    need('h.type === "Restricted Holiday"' in shared or "Restricted Holiday" in shared,
         "restricted holiday type not handled in engine")
    print("  PASS")

    # ---- 8. Holiday add/remove keeps punches + warns -----------------------
    print("\n[8] Holiday change reconciliation (req 8):")
    need("_reconcileHolidayChange" in admin, "holiday change reconciliation missing")
    need("Records were kept and the day recalculated" in admin,
         "no admin warning that existing punch records were kept")
    # finalizeStaleOpenPunches must not retro-flag holiday punches
    assert "isNonWorkingDay(r.date" in shared or "isNonWorkingDay(r.date" in shared.replace(" ", ""), \
        "stale-punch finaliser does not preserve holiday punches"
    print("  PASS")

    # ---- 9. admin.html settings + tokens + CSS -----------------------------
    print("\n[9] settings inputs, cache tokens and styling (req 9):")
    need('id="slWeekendsNonWorkingInput"' in admin_html, "weekend non-working toggle missing")
    need('id="slHolidayWorkModeInput"' in admin_html, "holiday work-mode selector missing")
    need("slWeekendsNonWorkingInput" in admin and "slHolidayWorkModeInput" in admin,
         "settings inputs not read in admin.js")
    # shared rule used by every JS screen
    for f in [app, admin]:
        need("isNonWorkingDay" in f, "a screen does not use the shared isNonWorkingDay rule")
    need("shared.js?v=20261027_wfh1" in index_html and "shared.js?v=20261027_wfh1" in admin_html,
         "shared.js token not bumped")
    need("app.js?v=20261027_roll1" in index_html, "app.js token not bumped")
    need("admin.js?v=20261026_sec1" in admin_html, "admin.js token not bumped")
    need("styles.css?v=20261026_nm2" in index_html and "styles.css?v=20261026_nm2" in admin_html,
         "styles.css token not bumped")
    # text + icon holiday states, not colour alone
    for cls in [".holiday-today-card", ".pill-holiday", ".badge-holidaywork", ".cell-holiday-work"]:
        need(cls in styles, f"CSS '{cls}' missing in styles.css")
    print("  PASS")

    print("\n" + "=" * 50)
    print(">>> HOLIDAY PUNCH-HIDING: ALL CHECKS PASSED <<<")
    print("=" * 50)


if __name__ == "__main__":
    try:
        verify_all()
    except AssertionError as e:
        print("\nVERIFICATION FAILED:", e)
        sys.exit(1)
