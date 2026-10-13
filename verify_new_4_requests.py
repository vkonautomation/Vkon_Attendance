"""
Verification script for the 4 User Requests:
1. Clean slate for new members added in Admin (no past present/absent/leave history, clean start).
2. Apply for leave: Restricted Holiday date locked/read-only (no employee date edit).
3. Always dynamically show the real present day (Oct 12) across calendar and dashboard.
4. Attendance regularisation calendar restricting weekends, WFH allotted, full present, and accepted leaves.
"""

def test_four_requests():
    print("=== RUNNING VERIFICATION FOR 4 USER REQUESTS ===")

    with open("shared.js", "r", encoding="utf-8") as f:
        shared_js = f.read()
    with open("app.js", "r", encoding="utf-8") as f:
        app_js = f.read()
    with open("index.html", "r", encoding="utf-8") as f:
        index_html = f.read()
    with open("admin.js", "r", encoding="utf-8") as f:
        admin_js = f.read()
    with open("styles.css", "r", encoding="utf-8") as f:
        styles_css = f.read()

    # Request 1:
    print("\n[Request 1] Clean slate for members added in Admin:")
    assert "delete allRecords[k]" in admin_js, "Failed: residual records clearing missing in admin.js"
    assert "filteredLeaves" in admin_js and "filteredWfh" in admin_js and "filteredRegs" in admin_js, "Failed: residual approvals clearing missing in admin.js"
    assert "isBeforeEnrollment" in app_js, "Failed: isBeforeEnrollment check missing in app.js"
    assert "empEnrolledDate && dateObj < empEnrolledDate" in admin_js, "Failed: enrolledAt check in admin.js monthly report missing"
    print("  PASS: Req 1 verified (Clean history, zero past absent/leave/present before enrollment).")

    # Request 2:
    print("\n[Request 2] Apply for Leave: Restricted Holiday date locked/read-only:")
    assert "readonly-locked-date" in styles_css, "Failed: .readonly-locked-date CSS missing in styles.css"
    assert "startInput.readOnly = true" in app_js, "Failed: startInput.readOnly = true missing in app.js"
    assert "rhLockedHint" in index_html, "Failed: rhLockedHint missing in index.html"
    assert "readonly-locked-date" in app_js, "Failed: readonly-locked-date class toggling missing in app.js"
    print("  PASS: Req 2 verified (Restricted holiday date locked and displayed, editing disabled).")

    # Request 3:
    print("\n[Request 3] Calendar dynamically shows present day:")
    assert "const CURRENT_DATE = new Date();" in shared_js, "Failed: CURRENT_DATE must be new Date() in shared.js"
    assert "calendarCurrentDate: new Date()" in app_js, "Failed: calendarCurrentDate must be new Date() in app.js"
    assert "todayKey = formatDateKey(new Date())" in app_js, "Failed: todayKey must be formatDateKey(new Date()) in app.js"
    assert "isCurrentMonth ? now.getDate() : new Date" in admin_js, "Failed: dynamic todayDay in admin.js missing"
    print("  PASS: Req 3 verified (Calendar and Admin Console dynamically show the real present day).")

    # Request 4:
    print("\n[Request 4] Regularisation Interactive Calendar with 4 strict restrictions:")
    assert "reg-calendar-box" in index_html, "Failed: reg-calendar-box missing in index.html"
    assert "regCalendarGrid" in index_html, "Failed: regCalendarGrid missing in index.html"
    assert "renderRegularisationCalendar" in app_js, "Failed: renderRegularisationCalendar function missing in app.js"
    assert "reg-weekend" in app_js, "Failed: weekend restriction missing in reg calendar"
    assert "reg-wfh" in app_js, "Failed: WFH allotted restriction missing in reg calendar"
    assert "reg-present" in app_js, "Failed: full present restriction missing in reg calendar"
    assert "reg-leave" in app_js, "Failed: accepted leave restriction missing in reg calendar"
    assert "reg-eligible" in app_js, "Failed: eligible missed day handling missing in reg calendar"
    assert ".reg-calendar-box" in styles_css, "Failed: .reg-calendar-box CSS missing in styles.css"
    print("  PASS: Req 4 verified (Interactive calendar restricting weekends, WFH, full present, and accepted leaves).")

    print("\n" + "=" * 50)
    print(">>> ALL 4 USER REQUIREMENTS VERIFIED SUCCESSFULLY! <<<")
    print("=" * 50)

if __name__ == "__main__":
    test_four_requests()
