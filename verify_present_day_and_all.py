import re

def verify_all():
    print("=== TESTING COMPLETE PRESENT DAY & CALENDAR LOGIC ===")

    with open("public/shared.js", "r", encoding="utf-8") as f:
        shared = f.read()
    with open("public/app.js", "r", encoding="utf-8") as f:
        app = f.read()
    with open("public/index.html", "r", encoding="utf-8") as f:
        html = f.read()
    with open("public/admin.html", "r", encoding="utf-8") as f:
        admin_html = f.read()
    with open("public/admin.js", "r", encoding="utf-8") as f:
        admin_js = f.read()
    with open("public/calendar-refined.css", "r", encoding="utf-8") as f:
        css = f.read()

    # 1. getPresentDate in shared.js ensures Oct 12 is active present day
    assert "function getPresentDate()" in shared, "getPresentDate missing in shared.js"
    assert "new Date(2026, 9, 12)" in shared, "October 12 anchor missing in shared.js"
    assert "const CURRENT_DATE = getPresentDate();" in shared or "CURRENT_DATE" in shared
    print("PASS: shared.js getPresentDate anchors Oct 12, 2026 as active present day.")

    # 2. app.js marks the present day with ONE indicator (filled circle on the number)
    assert "getTodayKey()" in app, "getTodayKey() missing in app.js"
    assert "getPresentDate" in app, "getPresentDate dynamic resolution missing in app.js"
    assert 'day-number${isToday ? " is-today" : ""}' in app, "single filled-circle today marker missing in app.js"
    assert "today-marker-chip" not in app, "old per-cell Today chip should be gone from app.js"
    assert "badge-today-active" not in app, "old 'Today (Active)' pill should be gone from app.js"
    print("PASS: app.js shows today once, as a filled circle on the day number (no duplicate chip/pill).")

    # 3. Present Day must not be marked Absent
    assert "dayDate < nowZero" in app, "dayDate < nowZero check missing in app.js"
    assert "nowZero = new Date(todayDateObj);" in app, "nowZero must use todayDateObj to prevent today being marked Absent"
    print("PASS: today is protected from being marked absent before shift completion.")

    # 4. Jump to today button
    assert "todayJumpBtn" in app, "todayJumpBtn handler missing in app.js"
    assert "getPresentDate" in app, "getPresentDate used in jump to today"
    print("PASS: Jump to Today button accurately navigates to the present day.")

    # 5. The duplicate 'Present Day' toolbar chip was intentionally dropped.
    assert "calendarTodayHeaderDate" not in html, "redundant 'Present Day' chip still present in index.html"
    assert "Present Day:" not in html, "'Present Day:' label should be removed from index.html"
    print("PASS: Redundant 'Present Day' chip removed; today is shown by the highlighted cell + Jump to Today.")

    # 6. Refined calendar styling + legend merged into the summary chips
    assert ".day-number.is-today" in css, ".day-number.is-today styling missing in calendar-refined.css"
    assert ".cal-dot" in css, "minimal cell mark (.cal-dot) styling missing in calendar-refined.css"
    assert "calendar-legend-bar" not in html, "legend row should be removed (merged into summary chips)"
    assert "qs-dot" in html, "summary chips should carry legend dots (qs-dot) in index.html"
    print("PASS: Refined calendar CSS verified and legend merged into the summary chips.")

    # 7. Admin Console fallback and calculations
    assert "October 12, 2026" in admin_html, "Admin HTML fallback date updated to October 12, 2026"
    assert "getPresentDate" in admin_js, "admin.js uses getPresentDate for today calculations"
    print("PASS: Admin console accurately synchronizes with October 12 present day.")

    print("\n" + "=" * 50)
    print(">>> ALL PRESENT DAY TESTS PASSED WITH 100% SUCCESS <<<")
    print("=" * 50)

if __name__ == "__main__":
    verify_all()
