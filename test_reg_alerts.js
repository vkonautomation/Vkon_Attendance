/*
 * VKON Regularisation-alert engine tests (Node).
 * Loads shared.js inside a localStorage shim and exercises the PURE function
 * getRegularisationAlerts(employee, now, settings) for real (not grep-checked).
 * Run: `node test_reg_alerts.js`.
 *
 * Guarantees verified (matching the acceptance criteria):
 *   - an Absent / Not Marked past workday raises an alert;
 *   - holidays, weekends, approved leave/WFH, pending requests, today and
 *     future dates never do;
 *   - a rejected request re-appears with a "resubmit" message;
 *   - urgency follows the payroll cut-off (info / warning / critical);
 *   - alerts sort most-urgent-first;
 *   - an approved regularisation (which writes a Present record) clears it.
 */
const fs = require("fs");
const vm = require("vm");
const path = require("path");

function loadShared() {
  const code = fs.readFileSync(path.join(__dirname, "public", "shared.js"), "utf8");
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
  sandbox.__consts = vm.runInContext("({ STORAGE_KEYS })", sandbox);
  return sandbox;
}

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { console.log(`  PASS: ${msg}`); passed++; }
  else { console.error(`  FAIL: ${msg}`); failed++; process.exitCode = 1; }
}

const ctx = loadShared();
const S = ctx.__consts.STORAGE_KEYS;
const EMP = { id: "EMP001", enrolledAt: "2026-01-10" };

function resetStore() {
  ctx.setStore(S.RECORDS, {});
  ctx.setStore(S.LEAVES, []);
  ctx.setStore(S.WFH, []);
  ctx.setStore(S.REGULARISATIONS, []);
  ctx.setStore(S.HOLIDAYS, []);
}
function addAbsent(empId, date) {
  const r = ctx.getStore(S.RECORDS, {});
  r[`${empId}_${date}`] = { employeeId: empId, date, status: "Absent" };
  ctx.setStore(S.RECORDS, r);
}
function addPresent(empId, date) {
  const r = ctx.getStore(S.RECORDS, {});
  r[`${empId}_${date}`] = { employeeId: empId, date, status: "Present", checkInTime: "09:00 AM", checkOutTime: "06:00 PM" };
  ctx.setStore(S.RECORDS, r);
}
function alerts(now, settings) { return ctx.getRegularisationAlerts(EMP, now, settings); }
function find(alertsArr, date) { return alertsArr.find(a => a.dateStr === date); }

// ---- 0: helper math (deadline = cut-off day of the FOLLOWING month) --------
ok(ctx._payrollCutOffKeyFor("2026-10-12", 25) === "2026-11-25",
   "_payrollCutOffKeyFor(Oct 12, day 25) => Nov 25 (matches the auto-LOP engine)");
ok(ctx._diffDays("2026-10-14", "2026-11-25") === 42, "_diffDays counts whole days");
ok(ctx._diffDays("2026-10-14", "2026-10-10") === -4, "_diffDays is negative when the target has passed");

// ---- 1: excluded days never alert ------------------------------------------
resetStore();
// an absent, present, not-marked-workday and a set of exclusions, all in Oct 2026
addAbsent("EMP001", "2026-10-08");                       // Thu, absent -> alert
ctx.setStore(S.HOLIDAYS, [{ date: "2026-10-07", name: "Test Holiday", type: "Declared Holiday" }]);
ctx.setStore(S.LEAVES, [{ employeeId: "EMP001", status: "Approved", date: "2026-10-09" }]); // Fri, approved leave
ctx.setStore(S.WFH, [{ employeeId: "EMP001", status: "Approved", date: "2026-10-15" }]);   // Thu, approved WFH
ctx.setStore(S.REGULARISATIONS, [{ id: "R1", employeeId: "EMP001", date: "2026-10-06", status: "Pending" }]); // pending
addPresent("EMP001", "2026-10-13");                      // Tue, present -> no alert

const now = new Date("2026-10-14T06:00:00Z");            // Wed 14 Oct (IST)
const set = { payrollCutOffDay: 25 };
let A = alerts(now, set);

ok(find(A, "2026-10-08"), "An absent workday raises an alert");
ok(find(A, "2026-10-08").statusLabel === "Absent", "Absent day reports status 'Absent'");
ok(!find(A, "2026-10-07"), "A declared holiday is excluded");
ok(!find(A, "2026-10-09"), "An approved leave day is excluded");
ok(!find(A, "2026-10-15"), "An approved WFH day is excluded");
ok(!find(A, "2026-10-06"), "A day with a pending regularisation is excluded");
ok(!find(A, "2026-10-13"), "A present day is excluded");
ok(!find(A, "2026-10-10") && !find(A, "2026-10-11"), "Weekends are excluded");
ok(!find(A, "2026-10-14"), "Today is excluded");
ok(!find(A, "2026-10-20"), "Future dates are excluded");

// ---- 2: a bare past workday (no record) is "Not Marked" --------------------
resetStore();
A = alerts(new Date("2026-10-14T06:00:00Z"), set);
ok(A.length > 0 && A.every(a => a.statusLabel === "Not Marked"),
   "Past workdays with no record surface as 'Not Marked'");

// ---- 3: a rejected request re-appears with a resubmit message --------------
resetStore();
ctx.setStore(S.REGULARISATIONS, [{ id: "R2", employeeId: "EMP001", date: "2026-10-08", status: "Rejected" }]);
A = alerts(new Date("2026-10-14T06:00:00Z"), set);
const rej = find(A, "2026-10-08");
ok(rej && rej.rejected === true, "A rejected regularisation shows again as unresolved");
ok(rej && /resubmit/i.test(rej.message), "Rejected alert invites the employee to resubmit");

// ---- 4: urgency transitions as the cut-off nears ---------------------------
resetStore();
addAbsent("EMP001", "2026-11-18");   // far from its Dec 25 deadline -> info
addAbsent("EMP001", "2026-10-15");   // deadline Nov 25; now Nov 23 -> 2 days -> warning
addAbsent("EMP001", "2026-09-15");   // deadline Oct 25; now Nov 23 -> past -> critical
const nearNow = new Date("2026-11-23T06:00:00Z");
A = alerts(nearNow, { payrollCutOffDay: 25 });
const info = find(A, "2026-11-18"), warn = find(A, "2026-10-15"), crit = find(A, "2026-09-15");
ok(info && info.urgency === "info" && !info.pastCutOff, ">3 days before cut-off => info");
ok(warn && warn.urgency === "warning" && warn.daysLeft <= 3, "<=3 days before cut-off => warning");
ok(warn && /is marked Absent/.test(warn.message) && /Regularise by/.test(warn.message), "Warning message names the status and deadline");
ok(crit && crit.urgency === "critical" && crit.pastCutOff === true, "After the cut-off => critical");
ok(crit && /counted as a full day of LOP/i.test(crit.message), "Critical message states it is counted as LOP");

// ---- 5: most urgent first (critical, then warning, then info) --------------
ok(A[0].urgency === "critical" && A[A.length - 1].urgency === "info",
   "Alerts are sorted most-urgent-first");

// ---- 6: pure - it writes nothing -------------------------------------------
resetStore();
addAbsent("EMP001", "2026-10-08");
const before = JSON.stringify([ctx.getStore(S.RECORDS, {}), ctx.getStore(S.LOP_ENTRIES, [])]);
alerts(new Date("2026-10-14T06:00:00Z"), set);
const after = JSON.stringify([ctx.getStore(S.RECORDS, {}), ctx.getStore(S.LOP_ENTRIES, [])]);
ok(before === after, "getRegularisationAlerts does not mutate any store (pure read)");

// ---- 7: approving the day (a Present record appears) clears the alert ------
resetStore();
addAbsent("EMP001", "2026-10-08");
ok(find(alerts(new Date("2026-10-14T06:00:00Z"), set), "2026-10-08"), "Day is flagged before resolution");
ctx.setStore(S.RECORDS, {});
addPresent("EMP001", "2026-10-08");
ok(!find(alerts(new Date("2026-10-14T06:00:00Z"), set), "2026-10-08"),
   "An approved day (Present record) no longer raises an alert");

// ---- 8: alerts before enrollment are never raised --------------------------
resetStore();
addAbsent("EMP001", "2025-12-10");
ok(!find(alerts(new Date("2026-01-05T06:00:00Z"), set), "2025-12-10"),
   "Days before the employee enrolled are excluded");

console.log(`\n=== ${passed} regularisation-alert assertions passed, ${failed} failed ===`);
if (!process.exitCode) console.log(">>> test_reg_alerts: ALL PASS <<<");
