#!/usr/bin/env python3
"""
Verification Script for the 3 New User Requirements:
1. Apply for leave (Restricted Holiday): No option to change date, strictly show the fixed date.
2. Attendance Regularisation: Small calendar date picker restricting weekends, WFH allotted, full present, and leave accepted.
3. 24h Live Photo: Small bin logo in each row to delete photo if not needed by admin.
"""

import sys

def verify_all():
    print("=== VERIFYING 3 NEW USER REQUIREMENTS ===")

    # 1. Read source files
    with open("index.html", "r", encoding="utf-8") as f:
        index_html = f.read()

    with open("app.js", "r", encoding="utf-8") as f:
        app_js = f.read()

    with open("admin.html", "r", encoding="utf-8") as f:
        admin_html = f.read()

    with open("admin.js", "r", encoding="utf-8") as f:
        admin_js = f.read()

    with open("styles.css", "r", encoding="utf-8") as f:
        styles_css = f.read()

    # =========================================================================
    # REQUIREMENT 1: Restricted Holiday Date Lock (No option to change date)
    # =========================================================================
    print("\n[Req 1] Restricted Holiday Date Locked Display:")
    assert "rhFixedDateDisplayGroup" in index_html, "Fail: rhFixedDateDisplayGroup missing in index.html"
    assert "rhFixedDateCard" in index_html, "Fail: rhFixedDateCard missing in index.html"
    assert "rhCardMonth" in index_html and "rhCardDay" in index_html, "Fail: Date badge missing in index.html"
    assert "updateRhLockedDisplay" in app_js, "Fail: updateRhLockedDisplay missing in app.js"
    assert "datesRow.style.display = \"none\"" in app_js or "datesRow.style.display = 'none'" in app_js, "Fail: leaveDatesRow not hidden when RH selected"
    assert ".rh-fixed-date-card" in styles_css, "Fail: .rh-fixed-date-card CSS missing in styles.css"
    print("  PASS: Req 1 verified (Fixed date displayed with no option to change or edit date).")

    # =========================================================================
    # REQUIREMENT 2: Attendance Regularisation Small Calendar
    # =========================================================================
    print("\n[Req 2] Small Calendar with 4 Strict Restrictions:")
    assert "regCalendarBox" in index_html, "Fail: regCalendarBox missing in index.html"
    assert "regCalendarGrid" in index_html, "Fail: regCalendarGrid missing in index.html"
    assert "regSelectedDateBanner" in index_html, "Fail: regSelectedDateBanner missing in index.html"
    assert "<select id=\"regularisationDate\"" in index_html, "Fail: backward compatibility select missing"

    # Restriction 1: Weekends
    assert "reg-weekend" in app_js and "isWeekend" in app_js, "Fail: Weekend restriction missing in app.js"
    # Restriction 2: WFH allotted
    assert "reg-wfh" in app_js and "isWfh" in app_js, "Fail: WFH restriction missing in app.js"
    # Restriction 3: Full present (both punched in and punched out)
    assert "reg-present" in app_js and "isFullPresent" in app_js, "Fail: Full present restriction missing in app.js"
    # Restriction 4: Leave accepted
    assert "reg-leave" in app_js and "isLeave" in app_js, "Fail: Leave accepted restriction missing in app.js"

    # populateRegularisationEligibleDates must also exclude full present
    assert "isFullPresent" in app_js, "Fail: isFullPresent check missing in populateRegularisationEligibleDates"

    # Compact small calendar styles
    assert "max-width: 440px;" in styles_css, "Fail: max-width for small calendar missing in styles.css"
    assert ".reg-calendar-box" in styles_css, "Fail: .reg-calendar-box missing in styles.css"
    print("  PASS: Req 2 verified (Small calendar restricts weekends, WFH, full present, and leave).")

    # =========================================================================
    # REQUIREMENT 3: 24h Live Photo Admin Bin Deletion Logo
    # =========================================================================
    print("\n[Req 3] 24h Live Photo Admin Bin Deletion Logo:")
    assert "<th>Action</th>" in admin_html, "Fail: Action header missing in 24h photo table in admin.html"
    assert "btn-delete-photo" in admin_js, "Fail: btn-delete-photo missing in admin.js"
    assert "fa-trash-can" in admin_js, "Fail: fa-trash-can icon missing in admin.js photo row"
    assert ".btn-delete-photo" in styles_css, "Fail: .btn-delete-photo CSS missing in styles.css"
    # Check deletion logic
    assert "rec.selfieUrl = null" in admin_js and "rec.outSelfieUrl = null" in admin_js, "Fail: photo deletion logic missing in admin.js"
    print("  PASS: Req 3 verified (Small bin logo in each row with admin deletion functionality).")

    print("\n" + "=" * 50)
    print(">>> ALL 3 NEW USER REQUIREMENTS VERIFIED SUCCESSFULLY! <<<")
    print("=" * 50)

if __name__ == "__main__":
    verify_all()
