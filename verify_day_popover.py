#!/usr/bin/env python3
"""
Static verification for the calendar DAY DETAILS POPOVER feature.

Confirms the punch details moved out of the day cell into a hover/focus/tap
popover, that both calendars (employee portal + admin) use the shared
DayPopover + getEffectiveStatus engine, and that the new shift-timing settings
(shift start, grace, lateness source) are wired end to end.

The lateness / short-by math itself is exercised for real by
`node test_day_popover.js` (pure engine, localStorage shim).
"""

import sys
import os


def read(name):
    with open("public/" + name, "r", encoding="utf-8") as f:
        return f.read()


def verify_all():
    print("=== VERIFYING CALENDAR DAY DETAILS POPOVER ===")

    shared = read("shared.js")
    app = read("app.js")
    admin = read("admin.js")
    pop = read(os.path.join("js", "day-popover.js"))
    admin_html = read("admin.html")
    index_html = read("index.html")
    styles = read("styles.css")

    def need(cond, msg):
        assert cond, "Fail: " + msg

    # ---- 1. Shared engine: getEffectiveStatus + settings -------------------
    print("\n[1] shared.js engine + shift-timing settings:")
    need("function getEffectiveStatus" in shared, "getEffectiveStatus missing in shared.js")
    need("function parseClockToMinutes" in shared, "parseClockToMinutes helper missing")
    need("function formatMinutesHM" in shared, "formatMinutesHM helper missing")
    for field in ["shiftStart", "graceMinutes", "lateFrom"]:
        need(field in shared, f"setting '{field}' missing in shared.js")
    need('late = { isLate: false, minutes: 0, label: "On time" }' in shared, "On-time default missing")
    need("late.label" in shared or "late = { isLate: true" in shared, "late label not computed")
    need("Short by" in shared, "short-by indicator missing")
    print("  PASS")

    # ---- 2. Popover component ----------------------------------------------
    print("\n[2] js/day-popover.js behaviour:")
    need("window.DayPopover" in pop, "DayPopover global not exported")
    need("function init" in pop and "function bind" in pop, "init/bind missing")
    need("OPEN_DELAY = 150" in pop, "150ms open delay missing")
    need('setAttribute("role", "dialog")' in pop, "role=dialog missing")
    need('aria-hidden' in pop, "aria-hidden not managed")
    need('"aria-describedby"' in pop, "aria-describedby not wired")
    need("pop-above" in pop, "flip-above positioning missing")
    need("e.key === \"Escape\"" in pop, "Escape-to-close missing")
    need("pointerType" in pop and "touch" in pop, "touch tap handling missing")
    need("function esc(" in pop, "HTML-escaping helper missing (XSS safety)")
    print("  PASS")

    # ---- 3. Employee calendar: minimal cell + popover ----------------------
    print("\n[3] app.js employee calendar:")
    need("workedMeta" not in app, "workedMeta (times/hours in cell) should be removed")
    need("DayPopover.bind(cell, popData)" in app, "employee cells not bound to popover")
    need("DayPopover.init()" in app, "DayPopover.init not called on startup")
    need("popData = null; // blank future day: no popover" in app, "future day should have no popover")
    print("  PASS")

    # ---- 4. Admin calendar + settings form ---------------------------------
    print("\n[4] admin.js calendar + settings:")
    need("DayPopover.bind(cell, popData)" in admin, "admin cells not bound to popover")
    need("DayPopover.init()" in admin, "DayPopover.init not called in admin")
    for inp in ["slShiftStartInput", "slGraceMinutesInput", "slLateFromInput"]:
        need(inp in admin, f"{inp} not read in admin.js")
    print("  PASS")

    # ---- 5. admin.html settings inputs -------------------------------------
    print("\n[5] admin.html shift-timing inputs:")
    for inp in ['id="slShiftStartInput"', 'id="slGraceMinutesInput"', 'id="slLateFromInput"']:
        need(inp in admin_html, f"{inp} missing in admin.html")
    need('value="graceEnd"' in admin_html, "lateFrom graceEnd option missing")
    print("  PASS")

    # ---- 6. Script tags + tokens + CSS -------------------------------------
    print("\n[6] script tags, cache tokens and popover CSS:")
    need("js/day-popover.js?v=" in index_html, "day-popover.js not loaded in index.html")
    need("js/day-popover.js?v=" in admin_html, "day-popover.js not loaded in admin.html")
    # day-popover.js must load AFTER shared.js (uses getEffectiveStatus) and
    # BEFORE the page controller that calls DayPopover.bind.
    assert index_html.index("shared.js?v=") < index_html.index("day-popover.js?v=") < index_html.index("app.js?v="), \
        "index.html script order wrong (expected shared -> day-popover -> app)"
    assert admin_html.index("shared.js?v=") < admin_html.index("day-popover.js?v=") < admin_html.index("admin.js?v="), \
        "admin.html script order wrong (expected shared -> day-popover -> admin)"
    need("shared.js?v=20261027_bk4" in index_html and "shared.js?v=20261027_bk4" in admin_html,
         "shared.js token not bumped")
    need("app.js?v=20261027_bk4" in index_html, "app.js token not bumped")
    need("admin.js?v=20261027_bk4" in admin_html, "admin.js token not bumped")
    need("styles.css?v=20261026_nm2" in index_html and "styles.css?v=20261026_nm2" in admin_html,
         "styles.css token not bumped")
    for cls in [".day-popover", ".dp-late", ".dp-short", ".dp-ontime", "focus-visible"]:
        need(cls in styles, f"CSS '{cls}' missing in styles.css")
    print("  PASS")

    print("\n" + "=" * 50)
    print(">>> DAY POPOVER: ALL CHECKS PASSED <<<")
    print("=" * 50)


if __name__ == "__main__":
    try:
        verify_all()
    except AssertionError as e:
        print("\nVERIFICATION FAILED:", e)
        sys.exit(1)
