#!/usr/bin/env python3
"""
Static verification for the Manager + Admin Approval Workflow.

Checks that the staged approval model (Leave / LOP / WFH / Regularisation) is
wired across shared.js (the engine), admin.js (approvals + settings), app.js
(employee portal + manager "Team Requests" console), index.html, admin.html and
styles.css. The pure routing / state-machine behaviour is exercised separately
by `node test_approval_workflow.js`.
"""

import sys

def read(name):
    with open("public/" + name, "r", encoding="utf-8") as f:
        return f.read()

def verify_all():
    print("=== VERIFYING MANAGER + ADMIN APPROVAL WORKFLOW ===")

    shared = read("shared.js")
    admin = read("admin.js")
    app = read("app.js")
    admin_html = read("admin.html")
    index_html = read("index.html")
    styles = read("styles.css")

    def need(cond, msg):
        assert cond, "Fail: " + msg

    # Req 3: staged status model exists in the engine.
    print("\n[Req 3] Status model:")
    for st in ["Pending Manager", "Pending Admin", "Approved", "Rejected", "Cancelled", "Cancellation Requested"]:
        need(st in shared, f"status '{st}' missing in shared.js engine")
    need("function initialStatusForRoute" in shared, "initialStatusForRoute missing")
    need("function stageFromStatus" in shared, "stageFromStatus missing")
    print("  PASS")

    # Req 2: per-type configurable flow + defaults.
    print("\n[Req 2] Configurable approval flow + defaults:")
    need("APPROVAL_FLOW" in shared and "vkon_approval_flow_v1" in shared, "approval-flow storage key missing")
    need("DEFAULT_APPROVAL_FLOW" in shared, "DEFAULT_APPROVAL_FLOW missing")
    need('leave: "manager_only"' in shared, "Leave default should be manager_only")
    need('wfh: "manager_only"' in shared, "WFH default should be manager_only")
    need('regularisation: "manager_only"' in shared, "Regularisation default should be manager_only")
    need('lop: "manager_then_admin"' in shared, "LOP default should be manager_then_admin")
    need("function getApprovalFlow" in shared and "function setApprovalFlow" in shared, "flow accessors missing")
    print("  PASS")

    # Engine core: routing, single-step advance, effects.
    print("\n[Engine] routing / advance / effects:")
    for fn in ["resolveApprovalRoute", "routingForNewRequest", "advanceApproval",
               "applyApprovedEffect", "removeApprovedEffect", "recordApprovalTrail"]:
        need("function " + fn in shared, fn + " missing in shared.js")
    # Req 4: no manager / self manager route straight to Admin.
    need('return ["admin"]' in shared, "no/self-manager route should fall back to admin")
    print("  PASS")

    # Req 5: manager scoping (reports only, never self); admin may act on any pending.
    print("\n[Req 5] Manager scoping + admin authority:")
    need("function isManagerOf" in shared and "function getDirectReports" in shared, "manager scoping helpers missing")
    need("e.id !== managerId" in shared, "self-manager exclusion missing (manager cannot approve self)")
    need("function hasTeam" in shared, "hasTeam missing")
    # advanceApproval validates authority and reason.
    need("reason_required" in shared, "reason-required rejection guard missing in advanceApproval")
    print("  PASS")

    # Req 6 + 7: reason on reject, audit trail with approver/decision/comment/when.
    print("\n[Req 6/7] Reason-on-reject + audit trail fields:")
    for frag in ["stage,", "approverId:", "approverName:", "role:", "decision,", "comment:", "at:"]:
        need(frag in shared, f"approval trail field '{frag}' missing in recordApprovalTrail")
    need("rejectionReason" in shared, "stored rejection reason missing")
    # admin reject prompts a required reason before calling the engine.
    need("reason_required" in admin, "admin reject should enforce a reason")
    print("  PASS")

    # Req 11: effects apply only at final Approved.
    print("\n[Req 11] Effects only at final approval:")
    need("applyApprovedEffect" in shared, "applyApprovedEffect not referenced")
    need("removeApprovedEffect" in shared, "removeApprovedEffect not referenced (cancel revert)")
    need("function cancelPendingRequest" in shared and "function requestAdminCancellation" in shared
         and "function resolveAdminCancellation" in shared, "cancellation state machine missing")
    print("  PASS")

    # Admin console: staged approvals, manager decision visible, acts on manager-pending.
    print("\n[Admin] staged approvals + manager decision surfaced:")
    need("function _adminApprovalDecision" in admin, "admin decisions not delegated to engine")
    need("function approvalStatusBadge" in admin, "admin stage badge helper missing")
    need("function renderApprovalTrail" in admin, "admin audit-trail renderer missing")
    need("isAdminActionableStatus" in admin, "admin actionable-status helper missing")
    need("Pending Manager" in admin, "admin should surface/act on manager-pending stage (Req 5/10)")
    need("renderApprovalFlowSettings" in admin and "initApprovalFlowSettings" in admin, "settings flow wiring missing")
    print("  PASS")

    # Settings approval-workflow card in admin.html.
    print("\n[Settings] approval-workflow card:")
    for sel in ["approvalFlowForm", "approvalFlowLeave", "approvalFlowWfh", "approvalFlowRegularisation", "approvalFlowLop"]:
        need(sel in admin_html, sel + " missing in admin.html")
    need("manager_then_admin" in admin_html, "flow route options missing in admin.html")
    print("  PASS")

    # Employee portal: submit routing, staged display, cancel-only-while-pending.
    print("\n[Portal] submit routing + staged display + cancel:")
    need("routingForNewRequest" in app, "employee submits not routed through the engine")
    need("Pending Manager" in app and "Pending Admin" in app, "staged statuses not shown in portal")
    need("cancelPendingRequest" in app and "requestAdminCancellation" in app, "employee cancel wiring missing")
    need("renderApprovalTrail" in admin, "trail rendering helper missing in admin")
    print("  PASS")

    # Req 8: Manager "Team Requests" surface (portal) + badge + calendar.
    print("\n[Req 8] Team Requests console:")
    for fn in ["initTeamRequestsNav", "renderTeamRequests", "managerDecide", "updateTeamBadge", "renderTeamCalendar"]:
        need("function " + fn in app, fn + " missing in app.js")
    need("pendingTeamRequestCount" in shared and "getTeamRequests" in shared, "team queue/count engine missing")
    need('data-view="team-requests"' in index_html, "Team Requests nav item missing in index.html")
    need('data-portal-view="team-requests"' in index_html, "Team Requests view section missing in index.html")
    need("teamRequestsBadge" in index_html, "sidebar pending badge element missing in index.html")
    need("teamCalendarWrap" in index_html, "team calendar container missing in index.html")
    print("  PASS")

    # CSS layer for the approval workflow.
    print("\n[CSS] v10.0 approval-workflow layer:")
    for sel in ["badge-pending-manager", "badge-pending-admin", "approval-trail",
                "team-req-card", "team-calendar", "nav-badge", "approval-flow-card"]:
        need(sel in styles, sel + " CSS missing")
    print("  PASS")

    # Cache tokens bumped for the current build (backend adapter wiring: bk1).
    print("\n[Cache] cache-buster tokens present (current build):")
    need("_apr" in index_html and "20261029_e7" in index_html, "index.html cache tokens not set")
    need("_apr" in admin_html and "20261029_e7" in admin_html, "admin.html cache tokens not set")
    print("  PASS")

    print("\n" + "=" * 54)
    print(">>> MANAGER + ADMIN APPROVAL WORKFLOW VERIFIED SUCCESSFULLY! <<<")
    print("=" * 54)

if __name__ == "__main__":
    try:
        verify_all()
    except AssertionError as e:
        print(str(e))
        sys.exit(1)
