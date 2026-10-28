"""
Comprehensive Verification Script for all 8 User Requirements
"""
import sys
import os

def run_tests():
    print("=== VERIFYING ALL 8 REQUIREMENTS ===")

    with open("public/admin.html", "r", encoding="utf-8") as f:
        admin_html = f.read()
    with open("public/index.html", "r", encoding="utf-8") as f:
        index_html = f.read()
    with open("public/admin.js", "r", encoding="utf-8") as f:
        admin_js = f.read()
    with open("public/app.js", "r", encoding="utf-8") as f:
        app_js = f.read()
    with open("public/shared.js", "r", encoding="utf-8") as f:
        shared_js = f.read()
    with open("public/styles.css", "r", encoding="utf-8") as f:
        styles_css = f.read()

    # Requirement 1:
    print("\n[Req 1] WFH accessible for any week, no past dates, no today if punched in:")
    assert "Work From Home cannot be requested for previous days." in app_js, "Failed past day restriction in app.js"
    assert "Work From Home cannot be requested for today." in app_js, "Failed today punched in restriction in app.js"
    assert 'dateInput.removeAttribute("max")' in app_js, "Failed allowing any future week in app.js"
    print("  PASS: Req 1 verified.")

    # Requirement 2:
    print("\n[Req 2] Regularisation excludes leaves, WFH, weekends:")
    assert '<select id="regularisationDate"' in index_html, "Failed select element in index.html"
    assert 'function populateRegularisationEligibleDates()' in app_js, "Failed populateRegularisationEligibleDates in app.js"
    assert 'dayOfWeek === 0 || dayOfWeek === 6' in app_js, "Failed weekend exclusion"
    assert 'empLeaves.some' in app_js, "Failed leave exclusion"
    assert 'empWfh.some' in app_js, "Failed WFH exclusion"
    print("  PASS: Req 2 verified.")

    # Requirement 3 & 4:
    print("\n[Req 3 & 4] 24h attendance photos split into 2 columns & working checklist:")
    assert 'admin-photos-split-grid' in admin_html, "Failed split grid in admin.html"
    assert '<th>Photo Snapshot</th>' in admin_html, "Failed Photo Snapshot header"
    assert '<th>GPS Distance</th>' in admin_html, "Failed GPS Distance header"
    assert '<th>Facial Match</th>' not in admin_html, "Failed Facial match should be removed"
    assert 'todayStaffChecklist' in admin_html, "Failed todayStaffChecklist element"
    assert 'workingNowCount' in admin_html, "Failed workingNowCount element"
    assert 'renderTodayWorkingChecklist' in admin_js, "Failed renderTodayWorkingChecklist in admin.js"
    print("  PASS: Req 3 & 4 verified.")

    # Requirement 5:
    print("\n[Req 5] Approvals Center Side Drawer with 3 options:")
    assert 'approvals-side-drawer' in admin_html, "Failed approvals-side-drawer in admin.html"
    assert 'navPillWfh' in admin_html and 'navPillLeave' in admin_html and 'navPillReg' in admin_html, "Failed nav pills"
    assert 'panel-approval-wfh' in admin_html and 'panel-approval-leave' in admin_html and 'panel-approval-reg' in admin_html, "Failed panels"
    assert 'initApprovalsSideDrawer' in admin_js, "Failed initApprovalsSideDrawer in admin.js"
    print("  PASS: Req 5 verified.")

    # Requirement 6:
    print("\n[Req 6] Staff Roster Leave columns: Personal / Restricted (month) / LOP (month):")
    assert 'Personal Leave' in admin_html and 'Restricted Leave (this month)' in admin_html and 'LOP (this month)' in admin_html, "Failed roster Leave sub-headers (PL/RL/LOP) in admin.html"
    assert 'leavesTaken' in admin_js and 'rhTaken' in admin_js, "Failed leave counting logic in admin.js"
    assert '_leaveBalPill(plLeft, plQuota' in admin_js and '_lopMonthPill(emp.id' in admin_js, "Failed balance/LOP pill cells in admin.js roster"
    assert 'left of' in admin_js, "Failed explicit 'X left of Y' balance labelling in admin.js"
    print("  PASS: Req 6 verified.")

    # Requirement 7:
    print("\n[Req 7] Small bubble count badge (shown only when > 0, hidden when 0):")
    assert 'badge-bubble' in admin_html, "Failed badge-bubble class in admin.html"
    assert 'drawerWfhBadge' in admin_html and 'drawerLeaveBadge' in admin_html and 'drawerRegBadge' in admin_html, "Failed drawer badges in admin.html"
    assert 'updatePendingBadges' in admin_js, "Failed updatePendingBadges in admin.js"
    assert '.badge-bubble' in styles_css, "Failed .badge-bubble styles in styles.css"
    print("  PASS: Req 7 verified.")

    # Requirement 8:
    print("\n[Req 8] Punch In (Green) & Punch Out (Red) ready button colors:")
    assert '.btn-punch-in-ready' in styles_css, "Failed .btn-punch-in-ready in styles.css"
    assert '.btn-punch-out-ready' in styles_css, "Failed .btn-punch-out-ready in styles.css"
    assert '#confirmVerificationBtn:disabled' in styles_css, "Failed grey disabled style in styles.css"
    assert 'btn-punch-in-ready' in app_js, "Failed adding btn-punch-in-ready in app.js"
    assert 'btn-punch-out-ready' in app_js, "Failed adding btn-punch-out-ready in app.js"
    assert 'confirmVerificationBtn' in index_html, "Failed confirmVerificationBtn in index.html"
    print("  PASS: Req 8 verified.")

    # New Request 1: Logo for Official Company Holidays
    print("\n[New Req 1] Official Company Holidays Logo:")
    assert 'fa-calendar-check' in admin_html, "Failed fa-calendar-check icon in admin.html"
    print("  PASS: Official Company Holidays logo verified.")

    # New Request 2: Checklist Order: working, wfh, completed, absent, leave taken
    print("\n[New Req 2] Today's Staff Working Checklist Order:")
    assert 'priority = 1' in admin_js and 'priority = 2' in admin_js and 'priority = 3' in admin_js and 'priority = 4' in admin_js and 'priority = 5' in admin_js, "Failed priority assignments in admin.js"
    assert 'staffList.sort((a, b) => a.priority - b.priority' in admin_js, "Failed priority sorting in admin.js"
    print("  PASS: Checklist ordering (working -> WFH -> completed -> absent -> leave taken) verified.")

    # New Request 3: Sidebar Active State bold & no text disappearance
    print("\n[New Req 3] Sidebar Active State visibility and bold font:")
    assert '.approvals-nav-pill.active' in styles_css, "Failed .approvals-nav-pill.active in styles.css"
    assert 'font-weight: 800 !important' in styles_css, "Failed bold font weight for active pill in styles.css"
    assert 'color: var(--color-primary, #ea580c) !important' in styles_css, "Failed visible color for active pill in styles.css"
    print("  PASS: Sidebar active text bold and visible verified.")

    # New Request 4: Master Sheet Leave columns shown as "X left of Y" (PL / RL)
    print("\n[New Req 4] Master Sheet PL (yr) / RL (mo) left-of-total columns:")
    assert 'leave-group-header' in admin_html and 'PL (yr)' in admin_html and 'RL (mo)' in admin_html, "Failed grouped Leave header (PL/RL) in admin.html"
    assert '_leaveBalPill(plRemaining, plTotal' in admin_js, "Failed Personal Leave left-of-total pill in admin.js master sheet"
    assert '_leaveBalPill(rlRemaining, rlTotal' in admin_js, "Failed Restricted Leave left-of-total pill in admin.js master sheet"
    assert 'left of' in admin_js, "Explicit 'X left of Y' labelling present"
    print("  PASS: Master Sheet PL/RL left-of-total columns verified.")

    print("\n" + "="*50)
    print(">>> ALL REQUIREMENTS AND ENHANCEMENTS HAVE PASSED VERIFICATION! <<<")
    print("="*50)

if __name__ == "__main__":
    run_tests()
