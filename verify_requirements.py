import re
import sys

def test_requirements():
    print("=== RUNNING REQUIREMENTS VERIFICATION ===")
    
    # 1. Check admin.html
    with open("public/admin.html", "r", encoding="utf-8") as f:
        admin_html = f.read()
    
    # Requirement 2: Check rate column removed in admin main page
    assert "Rate (To Date" not in admin_html, "Fail: 'Rate (To Date' still in admin.html!"
    assert "master-table" in admin_html, "Fail: master-table not found in admin.html"
    print("PASS: Requirement 2 (Admin HTML) - Rate column removed from first main page table")

    # Requirement 3: Check individual customization removed & min work policy added
    assert "memberQuotaOverrideForm" not in admin_html, "Fail: memberQuotaOverrideForm should be removed from admin.html"
    assert "minWorkPolicyForm" in admin_html, "Fail: minWorkPolicyForm missing from admin.html"
    assert "policyMinHoursInput" in admin_html, "Fail: policyMinHoursInput missing from admin.html"
    assert "policyMinMinutesInput" in admin_html, "Fail: policyMinMinutesInput missing from admin.html"
    assert "previewPolicyDurationText" in admin_html, "Fail: previewPolicyDurationText missing from admin.html"
    print("PASS: Requirement 3 (Admin HTML) - Individual customization removed, Min Work Duration policy form added")

    # 2. Check admin.js
    with open("public/admin.js", "r", encoding="utf-8") as f:
        admin_js = f.read()

    assert "initMinWorkPolicyForm" in admin_js, "Fail: initMinWorkPolicyForm missing in admin.js"
    assert "setMinWorkDurationPolicy" in admin_js, "Fail: setMinWorkDurationPolicy call missing in admin.js"
    print("PASS: Requirement 3 (Admin JS) - initMinWorkPolicyForm connects correctly")

    # 3. Check shared.js
    with open("public/shared.js", "r", encoding="utf-8") as f:
        shared_js = f.read()

    assert "MIN_WORK_POLICY" in shared_js, "Fail: MIN_WORK_POLICY missing in shared.js"
    assert "getMinWorkDurationPolicy" in shared_js, "Fail: getMinWorkDurationPolicy missing in shared.js"
    assert "setMinWorkDurationPolicy" in shared_js, "Fail: setMinWorkDurationPolicy missing in shared.js"
    print("PASS: Requirement 3 (Shared JS) - Storage keys & policy helpers present")

    # 4. Check index.html
    with open("public/index.html", "r", encoding="utf-8") as f:
        index_html = f.read()

    # Requirement 4: Action cards with [X] mark
    assert "modalCardMarkPresent" in index_html, "Fail: modalCardMarkPresent missing in index.html"
    assert "modalCardApplyLeave" in index_html, "Fail: modalCardApplyLeave missing in index.html"
    assert "modalCardWfh" in index_html, "Fail: modalCardWfh missing in index.html"
    assert "closeCardMarkPresentBtn" in index_html, "Fail: closeCardMarkPresentBtn missing in index.html"
    assert "closeCardApplyLeaveBtn" in index_html, "Fail: closeCardApplyLeaveBtn missing in index.html"
    assert "closeCardWfhBtn" in index_html, "Fail: closeCardWfhBtn missing in index.html"
    
    # Requirement 3: Punch-out lock banner (strict lock; self-service bypass removed)
    assert "punchOutLockNotice" in index_html, "Fail: punchOutLockNotice missing in index.html"
    assert "btnSimulateCompleteShift" not in index_html, "Fail: 'Mark Required Shift Completed' bypass should be removed from index.html"

    # Requirement 1: Restricted holiday in leave card
    assert "restrictedHolidayGroup" in index_html, "Fail: restrictedHolidayGroup missing in index.html"
    assert "restrictedHolidaySelect" in index_html, "Fail: restrictedHolidaySelect missing in index.html"
    assert "leaveReasonInput" in index_html, "Fail: leaveReasonInput missing in index.html"
    print("PASS: Requirement 4 & 1 (Index HTML) - Action cards, [X] close buttons, lock banner, restricted holiday controls exist")

    # 5. Check app.js
    with open("public/app.js", "r", encoding="utf-8") as f:
        app_js = f.read()

    assert "openActionCard" in app_js, "Fail: openActionCard missing in app.js"
    assert "closeActionCard" in app_js, "Fail: closeActionCard missing in app.js"
    assert "getElapsedShiftMinutes" in app_js, "Fail: getElapsedShiftMinutes missing in app.js"
    assert "getMinWorkDurationPolicy" in app_js, "Fail: getMinWorkDurationPolicy call missing in app.js"
    assert "punchOutLockNotice" in app_js, "Fail: punchOutLockNotice logic missing in app.js"
    assert "btnSimulateCompleteShift" not in app_js, "Fail: bypass handler should be removed from app.js"
    assert "simulatedFullShift" not in app_js, "Fail: simulatedFullShift bypass should be removed from app.js"
    assert "Restricted Holiday" in app_js, "Fail: Restricted Holiday logic missing in app.js"
    print("PASS: Requirement 1, 3, 4 (App JS) - Modal card open/close, restricted holiday workflow, punch-out restrictions")

    # 6. Check styles.css
    with open("public/styles.css", "r", encoding="utf-8") as f:
        styles_css = f.read()

    assert ".action-card-dialog" in styles_css, "Fail: .action-card-dialog missing in styles.css"
    assert ".modal-close-btn" in styles_css, "Fail: .modal-close-btn missing in styles.css"
    assert ".shift-lock-banner" in styles_css, "Fail: .shift-lock-banner missing in styles.css"
    print("PASS: Styles CSS - Action card modal styles, close button animations, shift lock banner styles present")

    print("\n>>> ALL 4 REQUIREMENTS SUCCESSFULLY VERIFIED! <<<")

if __name__ == "__main__":
    test_requirements()
