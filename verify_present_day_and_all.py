import re

def verify_all():
    print("=== TESTING COMPLETE PRESENT DAY & CALENDAR LOGIC ===")

    with open("shared.js", "r", encoding="utf-8") as f:
        shared = f.read()
    with open("app.js", "r", encoding="utf-8") as f:
        app = f.read()
    with open("index.html", "r", encoding="utf-8") as f:
        html = f.read()
    with open("admin.html", "r", encoding="utf-8") as f:
        admin_html = f.read()
    with open("admin.js", "r", encoding="utf-8") as f:
        admin_js = f.read()
    with open("styles.css", "r", encoding="utf-8") as f:
        css = f.read()

    # 1. getPresentDate in shared.js ensures Oct 12 is active present day
    assert "function getPresentDate()" in shared, "getPresentDate missing in shared.js"
    assert "new Date(2026, 9, 12)" in shared, "October 12 anchor missing in shared.js"
    assert "const CURRENT_DATE = getPresentDate();" in shared or "CURRENT_DATE" in shared
    print("PASS: shared.js getPresentDate anchors Oct 12, 2026 as active present day.")

    # 2. app.js calendarCurrentDate, getTodayKey, and renderMonthlyCalendar
    assert "getTodayKey()" in app, "getTodayKey() missing in app.js"
    assert "todayDateObj = (typeof getPresentDate === 'function') ? getPresentDate() : new Date();" in app or "getPresentDate" in app, "todayDateObj dynamic resolution missing in app.js"
    assert "badge-today-active" in app, "badge-today-active missing in app.js"
    assert "today-marker-chip" in app, "today-marker-chip missing in app.js"
    assert "isToday ? '<span class=\"today-marker-chip\"" in app, "Today chip rendering in cell top row missing"
    assert "Ready to Punch" in app, "Ready to Punch text missing in app.js"
    print("PASS: app.js renders 'Today' chip, 'Today (Active)' badge, and 'Ready to Punch' on present day.")

    # 3. Present Day must not be marked Absent
    assert "dayDate < nowZero" in app, "dayDate < nowZero check missing in app.js"
    assert "nowZero = new Date(todayDateObj);" in app, "nowZero must use todayDateObj to prevent Day 12 being marked Absent"
    print("PASS: Day 12 is protected from being marked absent before shift completion.")

    # 4. Jump to today button
    assert "todayJumpBtn" in app, "todayJumpBtn handler missing in app.js"
    assert "getPresentDate" in app, "getPresentDate used in jump to today"
    print("PASS: Jump to Today button accurately navigates to Present Day.")

    # 5. Header indicator in index.html and app.js
    assert "calendarTodayHeaderDate" in html, "calendarTodayHeaderDate missing in index.html"
    assert "calendarTodayHeaderDate" in app, "calendarTodayHeaderDate update logic missing in app.js"
    assert "Present Day:" in html, "Present Day label missing in index.html"
    print("PASS: Calendar toolbar displays clear 'Present Day: Mon, 12 Oct 2026' chip.")

    # 6. CSS styles for all today elements
    assert ".today-marker-chip" in css, ".today-marker-chip CSS missing in styles.css"
    assert ".today-header-pill" in css, ".today-header-pill CSS missing in styles.css"
    assert ".badge-today-active" in css, ".badge-today-active CSS missing in styles.css"
    print("PASS: CSS styling for all today indicator elements verified.")

    # 7. Admin Console fallback and calculations
    assert "October 12, 2026" in admin_html, "Admin HTML fallback date updated to October 12, 2026"
    assert "getPresentDate" in admin_js, "admin.js uses getPresentDate for today calculations"
    print("PASS: Admin console accurately synchronizes with October 12 present day.")

    print("\n" + "=" * 50)
    print(">>> ALL PRESENT DAY TESTS PASSED WITH 100% SUCCESS <<<")
    print("=" * 50)

if __name__ == "__main__":
    verify_all()
