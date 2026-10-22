/*
 * VKON Manager + Admin approval workflow unit tests (Node).
 * Loads shared.js inside a minimal browser shim so the routing / approval /
 * effect logic runs for real (not just grep-checked). Run: `node test_approval_workflow.js`.
 */
const fs = require("fs");
const vm = require("vm");
const path = require("path");

function loadShared() {
  const code = fs.readFileSync(path.join(__dirname, "shared.js"), "utf8");
  const store = new Map();
  const localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k)
  };
  const sandbox = { localStorage, console, setTimeout, setInterval: () => 0, Intl, Date, Math, JSON };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: "shared.js" });
  return sandbox;
}

let passed = 0;
let failed = 0;
function ok(cond, msg) {
  if (cond) { console.log(`  PASS: ${msg}`); passed++; }
  else { console.error(`  FAIL: ${msg}`); failed++; process.exitCode = 1; }
}

const ctx = loadShared();
const KEY = { EMPLOYEES: "vkon_employees_v6", LEAVES: "vkon_leaves_v6", WFH: "vkon_wfh_v6", REG: "vkon_regularisations_v6", RECORDS: "vkon_records_v6" };

// Deterministic roster: a manager, one report, a self-manager, and an employee
// with no manager.
ctx.setStore(KEY.EMPLOYEES, [
  { id: "EMPM", name: "The Manager", managerId: "", department: "Engineering", monthlySalary: 90000 },
  { id: "EMPC", name: "Cart Report", managerId: "EMPM", department: "Engineering", monthlySalary: 60000 },
  { id: "EMPS", name: "Self Boss", managerId: "EMPS", department: "Product", monthlySalary: 60000 },
  { id: "EMPN", name: "No Manager", managerId: "", department: "Operations", monthlySalary: 50000 }
]);

// 1) Defaults (Req 2): Leave/WFH/Reg = Manager only; LOP = Manager then Admin.
const flow = ctx.getApprovalFlow();
ok(flow.leave === "manager_only" && flow.wfh === "manager_only" && flow.regularisation === "manager_only", "Defaults: Leave/WFH/Reg are Manager-only");
ok(flow.lop === "manager_then_admin", "Default: LOP is Manager then Admin");

// 2) Routing + Req 4 (no manager / self manager go straight to Admin).
ok(JSON.stringify(ctx.resolveApprovalRoute("leave", "EMPC")) === '["manager"]', "Report + Manager-only => [manager]");
ok(JSON.stringify(ctx.resolveApprovalRoute("lop", "EMPC")) === '["manager","admin"]', "Report + LOP => [manager, admin]");
ok(JSON.stringify(ctx.resolveApprovalRoute("leave", "EMPN")) === '["admin"]', "No manager => [admin] (straight to Admin)");
ok(JSON.stringify(ctx.resolveApprovalRoute("leave", "EMPS")) === '["admin"]', "Self-manager => [admin] (cannot approve self)");
ok(ctx.routingForNewRequest("leave", "EMPC").status === "Pending Manager", "New report leave starts Pending Manager");
ok(ctx.routingForNewRequest("leave", "EMPN").status === "Pending Admin", "New no-manager leave starts Pending Admin");

// 3) Manager scoping (Req 5): a manager only acts on their own reports.
ok(ctx.isManagerOf("EMPM", "EMPC") === true, "EMPM is manager of EMPC");
ok(ctx.isManagerOf("EMPM", "EMPN") === false, "EMPM is not manager of EMPN");
ok(ctx.hasTeam("EMPM") === true && ctx.hasTeam("EMPN") === false, "hasTeam reflects direct reports");

// Helper to seed a request in a store.
function seedLeave(req) { const l = ctx.getStore(KEY.LEAVES, []); l.push(req); ctx.setStore(KEY.LEAVES, l); }
const ADMIN = { role: "admin", name: "Admin" };
const MANAGER = { role: "manager", id: "EMPM", name: "The Manager" };

// 4) Manager-only approval applies effects only on final approval (Req 11).
seedLeave({ id: "L1", employeeId: "EMPC", category: "Personal", type: "Personal Leave", startDate: "2026-10-14", endDate: "2026-10-14", daysCount: 1, status: "Pending Manager", approvalRoute: ["manager"], approvalTrail: [] });
let res = ctx.advanceApproval("leave", "L1", MANAGER, "approve", "");
ok(res && res.status === "Approved", "Manager-only approve => Approved");
ok(ctx.getStore(KEY.RECORDS, {})["EMPC_2026-10-14"], "Final approval writes an attendance record");
const trail = ctx.getStore(KEY.LEAVES, []).find(x => x.id === "L1").approvalTrail;
ok(trail.length === 1 && trail[0].stage === "manager" && trail[0].decision === "approved", "Audit trail records the manager decision");

// 5) Reject requires a reason (Req 6).
seedLeave({ id: "L2", employeeId: "EMPC", category: "Personal", startDate: "2026-10-15", endDate: "2026-10-15", daysCount: 1, status: "Pending Manager", approvalRoute: ["manager"], approvalTrail: [] });
res = ctx.advanceApproval("leave", "L2", MANAGER, "reject", "");
ok(res && res.error === "reason_required", "Reject with no reason is refused");
res = ctx.advanceApproval("leave", "L2", MANAGER, "reject", "Team blackout week");
ok(res && res.status === "Rejected" && res.rejectionReason === "Team blackout week", "Reject with reason => Rejected + stored reason");
ok(!ctx.getStore(KEY.RECORDS, {})["EMPC_2026-10-15"], "A rejected request writes no record");

// 6) Two-stage LOP: manager advances to Admin; effects only after Admin (Req 11).
seedLeave({ id: "L3", employeeId: "EMPC", category: "LossOfPay", type: "Loss of Pay (Unpaid)", startDate: "2026-10-16", endDate: "2026-10-16", daysCount: 1, status: "Pending Manager", approvalRoute: ["manager", "admin"], approvalTrail: [] });
res = ctx.advanceApproval("leave", "L3", MANAGER, "approve", "");
ok(res && res.status === "Pending Admin", "Manager approval on Manager-then-Admin => Pending Admin");
ok(!ctx.getStore(KEY.RECORDS, {})["EMPC_2026-10-16"], "No record until the final (Admin) approval");
res = ctx.advanceApproval("leave", "L3", ADMIN, "approve", "ok");
ok(res && res.status === "Approved", "Admin approval completes the chain => Approved");
ok(ctx.getStore(KEY.RECORDS, {})["EMPC_2026-10-16"], "Final Admin approval writes the record");

// 7) Authority guards (Req 5).
seedLeave({ id: "L4", employeeId: "EMPN", category: "Personal", startDate: "2026-10-19", endDate: "2026-10-19", daysCount: 1, status: "Pending Admin", approvalRoute: ["admin"], approvalTrail: [] });
res = ctx.advanceApproval("leave", "L4", MANAGER, "approve", "");
ok(res === null, "A manager cannot act on an Admin-stage request");
res = ctx.advanceApproval("leave", "L4", { role: "manager", id: "EMPM", name: "M" }, "approve", "");
ok(res === null, "A manager cannot act on a non-report's request");
// Admin CAN act on a manager-stage request (on behalf of an absent manager).
seedLeave({ id: "L5", employeeId: "EMPC", category: "Personal", startDate: "2026-10-20", endDate: "2026-10-20", daysCount: 1, status: "Pending Manager", approvalRoute: ["manager"], approvalTrail: [] });
res = ctx.advanceApproval("leave", "L5", ADMIN, "approve", "");
ok(res && res.status === "Approved", "Admin may approve a manager-stage request on their behalf");

// 8) Employee cancel only while pending (Req 9).
seedLeave({ id: "L6", employeeId: "EMPC", category: "Personal", startDate: "2026-10-21", endDate: "2026-10-21", daysCount: 1, status: "Pending Manager", approvalRoute: ["manager"], approvalTrail: [] });
ok(ctx.cancelPendingRequest("leave", "L6", "EMPC") && ctx.getStore(KEY.LEAVES, []).find(x => x.id === "L6").status === "Cancelled", "Pending request can be cancelled by its owner");
seedLeave({ id: "L7", employeeId: "EMPC", category: "Personal", startDate: "2026-10-22", endDate: "2026-10-22", daysCount: 1, status: "Approved", approvalRoute: ["manager"], approvalTrail: [] });
ok(ctx.cancelPendingRequest("leave", "L7", "EMPC") === null, "An Approved request cannot be direct-cancelled");
ok(ctx.requestAdminCancellation("leave", "L7", "EMPC").status === "Cancellation Requested", "Approved request can ask Admin to cancel");
ok(ctx.resolveAdminCancellation("leave", "L7", true).status === "Cancelled" && !ctx.getStore(KEY.RECORDS, {})["EMPC_2026-10-22"], "Admin approving cancellation reverts the record");

// 9) Team queue + badge (Req 8).
seedLeave({ id: "L8", employeeId: "EMPC", category: "Personal", startDate: "2026-10-23", endDate: "2026-10-23", daysCount: 1, status: "Pending Manager", approvalRoute: ["manager"], approvalTrail: [] });
const team = ctx.getTeamRequests("EMPM", ["Pending Manager"]);
ok(team.some(t => t.request.id === "L8") && !team.some(t => t.request.employeeId === "EMPS" || t.request.employeeId === "EMPN"), "Team queue lists only reports' manager-stage requests");
ok(ctx.pendingTeamRequestCount("EMPM") >= 1, "Pending team count badge is positive");

console.log(`\n=== ${passed} assertions passed, ${failed} failed ===`);
if (!failed) console.log(">>> test_approval_workflow: ALL PASS <<<");
