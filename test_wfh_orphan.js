/*
 * VKON WFH-orphan regression tests (Node).
 *
 * A day may only be marked WFH while an Approved WFH request backs it. The record
 * is a projection written by applyApprovedEffect and deleted by removeApprovedEffect,
 * so a row left behind by an import / reset / hand-edited store must not be able to
 * tell the employee they are working from home, consume the weekly allowance, or
 * hide the punch-in button.
 *
 * Loads shared.js for real inside a minimal browser shim. Run: `node test_wfh_orphan.js`.
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
  // Top-level `const`s are lexically scoped in a vm context, so they are read back
  // the same way the other harnesses do it.
  sandbox.__consts = vm.runInContext("({ STORAGE_KEYS, WEEKLY_WFH_ALLOWANCE })", sandbox);
  return sandbox;
}

let passed = 0;
function ok(cond, msg) {
  if (!cond) { console.error(`  FAIL: ${msg}`); process.exitCode = 1; }
  else { console.log(`  PASS: ${msg}`); passed++; }
}

const ctx = loadShared();
const S = ctx.__consts.STORAGE_KEYS;
const ORPHAN_DATE = "2026-10-26";
const BACKED_DATE = "2026-10-27";

function putRecord(empId, date, status, extra) {
  const recs = ctx.getStore(S.RECORDS, {});
  recs[`${empId}_${date}`] = Object.assign({
    employeeId: empId, date, status,
    checkInTime: "09:00 AM", checkOutTime: "06:00 PM",
    duration: "Scheduled Shift", hoursDecimal: 9, locationType: "Work From Home (Approved)"
  }, extra || {});
  ctx.setStore(S.RECORDS, recs);
}
function putWfh(empId, date, status) {
  const all = ctx.getStore(S.WFH, []);
  all.push({ id: `WFH-T-${date}`, employeeId: empId, date, status, weekKey: ctx.getWeekKey(new Date(date + "T00:00:00")) });
  ctx.setStore(S.WFH, all);
}
const hasRec = (empId, date) => !!ctx.getStore(S.RECORDS, {})[`${empId}_${date}`];

// 1) The seeded legitimate WFH day survives: WFH-101 is Approved for 2026-10-05.
ok(hasRec("EMP001", "2026-10-05"), "seeded WFH day backed by an approved request is kept");
ok(ctx.reconcileWfhRecords() === 0, "reconcile is a no-op on a consistent store");

// 2) An unbacked WFH day is dropped.
putRecord("EMP001", ORPHAN_DATE, "WFH");
ok(hasRec("EMP001", ORPHAN_DATE), "orphan day is present before reconcile");
ok(ctx.countWfhUsedInWeek("EMP001", ctx.getWeekKey(new Date(ORPHAN_DATE + "T00:00:00"))) === 1,
  "orphan day wrongly consumes 1 of the weekly WFH allowance before reconcile");
ok(ctx.reconcileWfhRecords() === 1, "reconcile reports exactly one dropped day");
ok(!hasRec("EMP001", ORPHAN_DATE), "orphan WFH day is removed");
ok(ctx.countWfhUsedInWeek("EMP001", ctx.getWeekKey(new Date(ORPHAN_DATE + "T00:00:00"))) === 0,
  "weekly WFH allowance is freed after reconcile");

// 3) A day backed by an Approved request is never touched.
putRecord("EMP001", BACKED_DATE, "WFH");
putWfh("EMP001", BACKED_DATE, "Approved");
ctx.reconcileWfhRecords();
ok(hasRec("EMP001", BACKED_DATE), "approved-and-backed WFH day is kept");

// 4) Only "Approved" legitimises the day. Anything still in flight, refused or
//    cancelled must not leave the employee told they are working from home.
["Pending Manager", "Pending Admin", "Pending", "Rejected", "Cancelled", "Cancellation Requested"].forEach((st) => {
  const d = `2026-11-${String(2 + ["Pending Manager", "Pending Admin", "Pending", "Rejected", "Cancelled", "Cancellation Requested"].indexOf(st)).padStart(2, "0")}`;
  putRecord("EMP002", d, "WFH");
  putWfh("EMP002", d, st);
});
const dropped = ctx.reconcileWfhRecords();
ok(dropped === 6, `reconcile drops a WFH day for every non-approved request status (dropped ${dropped})`);
ok(!hasRec("EMP002", "2026-11-02") && !hasRec("EMP002", "2026-11-07"), "no in-flight or refused day survives");

// 5) Other statuses are never touched, even with no request behind them.
putRecord("EMP003", "2026-10-26", "Present");
putRecord("EMP003", "2026-10-28", "Absent");
putRecord("EMP003", "2026-10-29", "Leave");
ctx.reconcileWfhRecords();
ok(hasRec("EMP003", "2026-10-26") && hasRec("EMP003", "2026-10-28") && hasRec("EMP003", "2026-10-29"),
  "Present / Absent / Leave rows are left alone");

// 6) The identity may come from the record key when the row omits employeeId.
const recs = ctx.getStore(S.RECORDS, {});
recs["EMP004_2026-10-26"] = { date: "2026-10-26", status: "WFH" };
ctx.setStore(S.RECORDS, recs);
ctx.reconcileWfhRecords();
ok(!ctx.getStore(S.RECORDS, {})["EMP004_2026-10-26"],
  "orphan detected via the key when the row carries no employeeId");

// 7) The predicate itself is defensive about empty input.
ok(ctx.hasApprovedWfhRequest("", ORPHAN_DATE) === false, "hasApprovedWfhRequest rejects an empty employee id");
ok(ctx.hasApprovedWfhRequest("EMP001", "") === false, "hasApprovedWfhRequest rejects an empty date");
ok(ctx.hasApprovedWfhRequest("EMP001", "2026-10-05") === true, "hasApprovedWfhRequest confirms the seeded approval");

console.log(`\n=== ${passed} WFH-orphan assertions passed ===`);
if (!process.exitCode) console.log(">>> test_wfh_orphan: ALL PASS <<<");
