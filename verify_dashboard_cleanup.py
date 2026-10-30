#!/usr/bin/env python3
"""
Static verification for the DASHBOARD CLEANUP (12 recommendations).

The dashboard was rebuilt so that each region does exactly one job: one Today
card with one primary action, one status sentence, no policy-chip row, plain
number cards instead of icon tiles, one Balances card, a plain regularisation
list whose only colour is the "Cut-off passed" label, a small next-holiday card,
a two-column layout, a narrow palette, and text beside every colour so nothing
depends on colour alone.

Each check names the recommendation it protects. The paint lives in the
committed dashboard-refined.css (loaded after styles.css, which is never
edited here); the markup is in index.html / admin.html; the behaviour is in
app.js.
"""

import re
import sys


def read(name):
    with open("public/" + name, "r", encoding="utf-8") as f:
        return f.read()


def verify_all():
    print("=== VERIFYING DASHBOARD CLEANUP (12 RECOMMENDATIONS) ===")

    index_html = read("index.html")
    admin_html = read("admin.html")
    app = read("app.js")
    admin = read("admin.js")
    css = read("dashboard-refined.css")

    def need(cond, msg):
        assert cond, "Fail: " + msg

    def count(hay, needle):
        return hay.count(needle)

    # ---- 1. One Today card, one primary button -----------------------------
    print("\n[1] One Today card with the clock and a single primary button:")
    need("today-card" in index_html and "today-card-title" in index_html,
         "no Today card in index.html")
    need("btn-long-mark-present" not in index_html and "action-sub-buttons-row" not in index_html,
         "the old long Mark Present bar / two-button row is still there")
    need("today-punch-btn" in index_html, "no primary punch button in the Today card")
    # The two punch buttons are one-at-a-time states of the same action, and the
    # card holds no other button besides the quiet text links.
    _card = index_html[index_html.index("today-card"):index_html.index("today-links")]
    need(count(_card, "today-punch-btn") == 2 and count(_card, "today-link") == 0,
         "punch buttons are not the only buttons in the Today card body")
    need(count(_card, "class=\"punch-main\"") == 2,
         "each punch state must carry exactly one button label")
    need("liveClockWidget" in _card, "the clock did not move into the Today card")
    need("openPunchInModalBtn" in app and "openPunchOutModalBtn" in app,
         "app.js no longer drives the punch buttons")
    print("  PASS")

    # ---- 2. One status line, not a pill plus a badge -----------------------
    print("\n[2] One status line in the Today card:")
    need("Not punched in" in app, "the status sentence is not written by app.js")
    need("Not punched in" in index_html, "the status sentence is not in the markup")
    # Scope the dead-wording check to the dashboard code (the day-details modal is
    # a different surface and is allowed to word things its own way).
    dash = app[app.index("function _paintTodayCard"):app.index("function openVerificationModal")]
    for dead in ["Ready to Punch", "Today: Not Punched In", "status-indicator-dot",
                 "long-btn-status-pill"]:
        need(dead not in dash, f"the dashboard code still says '{dead}' (duplicate status wording)")
    need("_paintTodayCard" in app and count(app, "function _paintTodayCard") == 1,
         "the status line is not painted from one place")
    need('id="todayStatusText"' in index_html and count(index_html, 'id="todayStatusText"') == 1,
         "there must be exactly one status text element")
    print("  PASS")

    # ---- 3. Quiet header: initials avatar, no bell, no photo ---------------
    print("\n[3] Header profile is quiet text with an initials avatar:")
    need("notifBellBtn" not in index_html and "notif-badge" not in index_html,
         "the notification bell is still in the header")
    need("chip-initials" in index_html and "currentEmpInitials" in app,
         "no initials avatar in the header")
    need("chip-manager" in index_html and "Manager: ${mgrName}" in app,
         "the manager line is not plain text")
    need("<i class=\"fa-solid fa-user-tie\"></i> Manager:" not in app,
         "the manager line still carries an icon")
    need(".portal-navbar .chip-avatar { display: none; }" in css,
         "the photo is not hidden behind the initials avatar")
    print("  PASS")

    # ---- 4. Policy chip row deleted, geofence kept as one line -------------
    print("\n[4] Policy chip row gone, geofence kept as a small line:")
    for dead in ["policy-chip", "policyBadgesRow", "policy-badges-row", "policyZone"]:
        need(dead not in index_html, f"{dead} still present in index.html")
    need("todayGeofenceRule" in index_html and "_geofenceRuleText" in app,
         "the geofence rule did not survive as one line")
    need("within ${s.radius} m of ${s.name}" in app,
         "the geofence line does not state the real radius from settings")
    print("  PASS")

    # ---- 5. Two plain number cards, no icon tiles --------------------------
    print("\n[5] Only Days present and Hours logged, as plain numbers:")
    need("dash-number-card" in index_html and count(index_html, "dash-number-card") >= 2,
         "no plain number cards")
    need("dash-stat-icon" not in index_html and "dash-stats-grid" not in index_html,
         "the old icon stat cards are still in the markup")
    need("dashStatDaysPresent" in index_html and "dashStatHours" in index_html,
         "the two headline figures are missing")
    need("dashStatWfh" in index_html and "dashStatLeaves" in index_html,
         "WFH / leave counts vanished instead of moving to Balances")
    need(".dash-number-lbl { font-size: .7rem;" in css,
         "the number-card label is not the small uppercase style")
    print("  PASS")

    # ---- 6. One Balances card, three rows with thin bars -------------------
    print("\n[6] One Balances card with three rows and thin bars:")
    need("balances-card" in index_html, "no Balances card")
    need(count(index_html, 'class="balance-row"') == 3,
         "the Balances card must hold exactly three rows")
    for lbl in ["Annual leave", "WFH this week", "Restricted holidays"]:
        need(lbl in index_html, f"Balances row '{lbl}' missing")
    for bar in ["balanceLeaveBar", "balanceWfhBar", "balanceRhBar"]:
        need(bar in index_html and bar in app, f"{bar} not wired to both markup and app.js")
    need("_setBar" in app, "no single place computes the balance bars")
    need("countRhUsedInMonth" in app and "balanceRhVal" in app,
         "the restricted-holiday row is not computed")
    need(".balance-bar { display: block; height: 3px;" in css,
         "the balance bars are not thin")
    print("  PASS")

    # ---- 7. Regularisation is a plain list with dividers -------------------
    print("\n[7] Regularisation: plain list, one line of explanation:")
    need("reg-list-card" in index_html and "sectionRegAlertBanner" in index_html,
         "the regularisation list card is missing")
    need("regAlertBannerList" in index_html and "rab-item" in app,
         "the list itself is not rendered")
    need(".reg-list-card .rab-item {" in css and "border-top: 1px solid var(--cd-line);" in css,
         "rows are not separated by dividers")
    # The explanation must state the past-cut-off count, not a generic warning.
    need("past the payroll cut-off and counted as loss of pay" in app,
         "the explanation line no longer states how many days are past cut-off")
    need("rab-head" not in index_html, "the old alert-card header block is still there")
    print("  PASS")

    # ---- 8. Red only on the cut-off label ---------------------------------
    print("\n[8] 'Cut-off passed' is the single red signal in a row:")
    need("Cut-off passed" in app, "the cut-off label text is gone")
    need(".reg-list-card .rab-locked { color: var(--cd-danger);" in css,
         "the cut-off label is not the red element")
    need(".reg-list-card .rab-item-msg { font-size: .82rem; line-height: 1.45; color: var(--cd-ink); }" in css,
         "the row text is not neutral ink")
    # the old per-urgency coloured left border must be switched off in the new card
    _ri = css[css.index(".reg-list-card .rab-item {"):css.index(".reg-list-card .rab-item:first-child")]
    need("border: 0" in _ri and "box-shadow: none" in _ri,
         "rows still carry the coloured urgency border")
    need("rab-locked" in app and "rab-reg-btn" in app,
         "the row must offer Regularise or explain why it cannot")
    print("  PASS")

    # ---- 9. Holiday shrinks to a small card in the side column -------------
    print("\n[9] Next holiday is a small card in the right column:")
    need("holiday-next-card" in index_html and "dashboard-col-side" in index_html,
         "no compact holiday card in the side column")
    need("uh-date-badge" not in app and "uh-card" not in index_html,
         "the old full-width holiday panel is still rendered")
    need("Declared holiday" in app and "Restricted holiday" in app,
         "the holiday type label is missing")
    need("In ${days} days" in app, "the 'in N days' line is missing")
    need(".slice(0, 2)" in app, "the card still lists a long run of holidays")
    print("  PASS")

    # ---- 10. One green, one red, one amber --------------------------------
    print("\n[10] Palette reduced: green = action, red = problem, amber = holiday:")
    need("--cd-action:" in css and "--cd-danger:" in css and "--cd-holiday:" in css,
         "the narrow palette tokens are missing")
    need("background: var(--cd-action)" in css, "the primary button is not the green token")
    need(count(css, "--cd-danger") <= 3, "red is used in more than the problem states")
    need(".hn-tag { font-size: .74rem; font-weight: 600; color: var(--cd-holiday); }" in css,
         "the holiday tag is not the amber token")
    # admin dashboard: decoration tiles removed (other admin tabs are out of scope)
    adash = admin_html[admin_html.index('id="tab-dashboard"'):admin_html.index('id="tab-recruitment"')]
    for dead in ["icon-bg-green", "icon-bg-amber", "icon-bg-purple", "icon-bg-blue", "icon-bg-rose"]:
        need(dead not in adash, f"admin KPI still carries the {dead} tile")
    need(".admin-shell .kpi-icon { display: none; }" in css,
         "admin KPI icons are not switched off")
    need("kpi-icon" not in adash, "the admin KPI icon markup is still present")
    print("  PASS")

    # ---- 11. Type and two-column layout -----------------------------------
    print("\n[11] Larger body text, uppercase only on card titles, two columns:")
    need("dashboard-grid" in index_html and ".dashboard-grid {" in css,
         "no two-column dashboard grid")
    need("grid-template-columns: minmax(0, 1.7fr) minmax(260px, 1fr)" in css,
         "the dashboard columns are not the intended split")
    need("@media (max-width: 1080px)" in css, "the grid never collapses on small screens")
    need(count(css, "text-transform: uppercase") <= 4,
         "uppercase labels are still sprayed across the dashboard")
    need(".card-title {" in css and "text-transform: uppercase" in css[css.index(".card-title {"):css.index(".card-title {") + 220],
         "card titles are not the uppercase labels")
    need("font-size: .95rem; font-weight: 600" in css,
         "the status sentence is not one notch larger body text")
    need("Today At A Glance" not in adash and "Check-Ins Today" not in adash,
         "admin dashboard headings are still in title/screaming case")
    print("  PASS")

    # ---- 12. Accessibility: text with colour, 44px targets, focus ----------
    print("\n[12] Colour paired with text, and tappable targets:")
    need("role=\"status\"" in index_html and "aria-live=\"polite\"" in index_html,
         "the status line is not announced")
    need("Not punched in" in app and "Cut-off passed" in app,
         "the two states must carry words, not only colour")
    need("min-height: 44px" in css, "no 44px minimum on the dashboard controls")
    need(re.search(r"\.today-punch-btn \{[^}]*min-height: 44px", css) is not None,
         "the primary punch button has no 44px minimum")
    need(re.search(r"\.today-link \{[^}]*min-height: 44px", css) is not None,
         "the quiet text links have no 44px tap target")
    print("  PASS")

    # ---- wiring: the new sheet is loaded last, tokens are current ----------
    print("\n[13] stylesheet load order, tokens and dead markup:")
    need("styles.css?v=20261026_nm2" in index_html and "styles.css?v=20261026_nm2" in admin_html,
         "styles.css token changed (it must stay untouched)")
    need("dashboard-refined.css?v=20261030_dr1" in index_html and
         "dashboard-refined.css?v=20261030_dr1" in admin_html,
         "dashboard-refined.css is not linked from both pages")
    need(index_html.index("styles.css?") < index_html.index("dashboard-refined.css?"),
         "dashboard-refined.css must load after styles.css in index.html")
    need(admin_html.index("styles.css?") < admin_html.index("dashboard-refined.css?"),
         "dashboard-refined.css must load after styles.css in admin.html")
    need("shared.js?v=20261030_e10" in index_html and "app.js?v=20261030_e10" in index_html,
         "index.html cache token not bumped")
    need("shared.js?v=20261030_e10" in admin_html and "admin.js?v=20261030_e10" in admin_html,
         "admin.html cache token not bumped")
    # the holiday rule and the calendar still rely on these hooks
    need("mark-present-bar-wrapper" in app and "todayStatusBadge" in app,
         "the holiday hide-rule lost its hooks")
    need("closeActionCard" in app and "openActionCard" in app,
         "the action cards are no longer wired")
    print("  PASS")

    print("\n" + "=" * 56)
    print(">>> DASHBOARD CLEANUP: ALL 12 RECOMMENDATIONS VERIFIED <<<")
    print("=" * 56)


if __name__ == "__main__":
    try:
        verify_all()
    except AssertionError as e:
        print("\nVERIFICATION FAILED:", e)
        sys.exit(1)
