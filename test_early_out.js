/*
 * VKON Early Out / Short Leave policy-engine unit tests (Node).
 * Loads shared.js inside a minimal localStorage shim so the classification rules
 * can be executed for real (not just grep-checked). Run: `node test_early_out.js`.
 *
 * Decision table verified (R=9 required, M=8 min-Present, H=5 half-day, cap=2h,
 * monthly limit=2):
 *   W >= R            -> Present
 *   M <= W < R        -> Present (meets minimum, no tag)
 *   W < H             -> Half-day (LOP)  (unpaid half)
 *   approved EO within limit            -> Short leave
 *   approved EO over limit, treatment=lop        -> Half-day (LOP)
 *   approved EO over limit, treatment=half-day   -> Half-day (consumes 0.5 PL)
 *   H <= W < M, no EO, not past cut-off -> Short hours - review
 *   H <= W < M, no EO, past cut-off     -> Short hours (LOP) [idempotent auto-LOP]
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
  // const-declared top-level bindings are not attached to the global object, so
  // pull the ones the tests need out via an in-context expression.
  sandbox.__consts = vm.runInContext(
    "({ STORAGE_KEYS, APPROVAL_TYPES, DEFAULT_APPROVAL_FLOW, DEFAULT_SHORT_LEAVE_SETTINGS })", sandbox);
  return sandbox;
}

let passed = 0;
let failed = 0;
function ok(cond, msg) {
  if (cond) { console.log(`  PASS: ${msg}`); passed++; }
  else { console.error(`  FAIL: ${msg}`); failed++; process.exitCode = 1; }
}

const ctx = loadShared();
const C = ctx.__consts;
const S = C.STORAGE_KEYS;

// ---- helpers ---------------------------------------------------------------
function setRecords(map) { ctx.setStore(S.RECORDS, map); }
function addRecord(empId, date, inT, outT) {
  const recs = ctx.getStore(S.RECORDS, {});
  recs[`${empId}_${date}`] = {
    employeeId: empId, date, status: "Present",
    checkInTime: inT, checkOutTime: outT, duration: "-",
    hoursDecimal: 0, locationType: "Office", bioVerified: true
  };
  ctx.setStore(S.RECORDS, recs);
}
function addEarlyOut(empId, date, treatment, status) {
  const list = ctx.getStore(S.EARLY_OUTS, []);
  const id = `EO-${empId}-${date}`;
  list.push({
    id, employeeId: empId, date, plannedLeaveTime: "05:00 PM",
    reason: "personal", overLimitTreatment: treatment || "half-day-leave",
    emergency: false, status: status || "Approved",
    approvalRoute: ["manager"], approvalTrail: [], createdAt: "2026-01-01T00:00:00.000Z"
  });
  ctx.setStore(S.EARLY_OUTS, list);
  return id;
}
function clearAll() {
  ctx.setStore(S.RECORDS, {});
  ctx.setStore(S.EARLY_OUTS, []);
  ctx.setStore(S.LEAVES, []);
  ctx.setStore(S.LOP_ENTRIES, []);
  ctx.setStore(S.AUDIT_LOG, []);
}
function classify(empId, date) { return ctx.classifyDay(empId, date); }
function activeLopForDate(empId, date) {
  return ctx.getLopEntries().filter(e => e.employeeId === empId && e.date === date && e.status === "active").length;
}

// Defaults (R=9, M=8, H=5, cap=2, limit=2, cut-off=1).
ctx.setAttendanceSettings({
  requiredHours: 9, minPresentHours: 8, halfDayThresholdHours: 5,
  shortLeaveMonthlyLimit: 2, shortLeaveMaxHoursEach: 2, payrollCutOffDay: 1
});
const st = ctx.getAttendanceSettings();
ok(st.requiredHours === 9 && st.minPresentHours === 8 && st.halfDayThresholdHours === 5 &&
   st.shortLeaveMonthlyLimit === 2 && st.shortLeaveMaxHoursEach === 2 && st.payrollCutOffDay === 1,
   "getAttendanceSettings reflects saved values");

// ---- engine wiring presence ------------------------------------------------
ok(C.APPROVAL_TYPES.indexOf("earlyout") !== -1, "APPROVAL_TYPES includes 'earlyout'");
ok(C.DEFAULT_APPROVAL_FLOW.earlyout === "manager_only", "Default early-out flow is manager_only");
ok(ctx.approvalTypeStoreKey("earlyout") === S.EARLY_OUTS, "earlyout maps to EARLY_OUTS store key");

// ---- 1 & 2: full / minimum Present ----------------------------------------
clearAll();
addRecord("EMP001", "2026-10-05", "09:00 AM", "06:00 PM"); // 9h
ok(classify("EMP001", "2026-10-05").classification === "Present", "W>=9 => Present");
addRecord("EMP001", "2026-10-06", "09:00 AM", "05:00 PM"); // 8h
ok(classify("EMP001", "2026-10-06").classification === "Present", "8<=W<9 => Present (meets minimum)");

// ---- 3: below half-day threshold always half-day (LOP) --------------------
clearAll();
addRecord("EMP001", "2099-03-05", "09:00 AM", "01:30 PM"); // 4.5h < 5
const rHalf = classify("EMP001", "2099-03-05");
ok(rHalf.classification === "Half-day (LOP)" && rHalf.lopFraction === 0.5, "W<5 => Half-day (LOP) 0.5");

// ---- 4a: approved early-out cases ---------------------------------------
// Early-out on a day that was actually worked full 9h has no shortfall => stays Present.
clearAll();
addRecord("EMP001", "2026-10-08", "09:00 AM", "06:00 PM"); // 9h (shortfall 0)
addEarlyOut("EMP001", "2026-10-08", "half-day-leave", "Approved");
ok(classify("EMP001", "2026-10-08").classification === "Present", "Early-out day worked full 9h stays Present (no shortfall)");

// shortfall of 1.5h (worked 7.5h) within cap 2h and limit 2 => Short leave
setRecords({}); ctx.setStore(S.EARLY_OUTS, []);
addRecord("EMP001", "2026-10-09", "09:00 AM", "04:30 PM"); // 7.5h, shortfall 1.5h
addEarlyOut("EMP001", "2026-10-09", "half-day-leave", "Approved");
ok(classify("EMP001", "2026-10-09").classification === "Short leave", "Approved EO within limit => Short leave");

// ---- 4b: over-limit early-out, treatment = lop => Half-day (LOP) ----------
clearAll();
addRecord("EMP001", "2026-10-12", "09:00 AM", "04:30 PM"); // shortfall 1.5
addRecord("EMP001", "2026-10-13", "09:00 AM", "04:30 PM"); // shortfall 1.5
addRecord("EMP001", "2026-10-14", "09:00 AM", "04:30 PM"); // 3rd in month -> over the 2/month limit
addEarlyOut("EMP001", "2026-10-12", "lop", "Approved");
addEarlyOut("EMP001", "2026-10-13", "lop", "Approved");
addEarlyOut("EMP001", "2026-10-14", "lop", "Approved");
const overLimit = classify("EMP001", "2026-10-14");
ok(overLimit.classification === "Half-day (LOP)" && overLimit.lopFraction === 0.5,
   "3rd within-cap EO exceeds monthly limit => over-limit treatment 'lop' Half-day (LOP)");

// first two within limit are Short leave
ok(classify("EMP001", "2026-10-12").classification === "Short leave", "1st within-limit EO => Short leave");
ok(classify("EMP001", "2026-10-13").classification === "Short leave", "2nd within-limit EO => Short leave");

// ---- 4c: over-limit early-out, treatment = half-day-leave => Half-day + PL
clearAll();
addRecord("EMP001", "2026-10-12", "09:00 AM", "04:30 PM");
addRecord("EMP001", "2026-10-13", "09:00 AM", "04:30 PM");
addRecord("EMP001", "2026-10-14", "09:00 AM", "04:30 PM");
addEarlyOut("EMP001", "2026-10-12", "half-day-leave", "Approved");
addEarlyOut("EMP001", "2026-10-13", "half-day-leave", "Approved");
addEarlyOut("EMP001", "2026-10-14", "half-day-leave", "Approved");
const hdLeave = classify("EMP001", "2026-10-14");
ok(hdLeave.classification === "Half-day" && hdLeave.consumePLHalf === true,
   "Over-limit EO treatment 'half-day-leave' => Half-day consuming 0.5 PL");

// getShortLeaveUsage caps at the monthly limit
ok(ctx.getShortLeaveUsage("EMP001", "2026-10") === 2, "getShortLeaveUsage caps at monthly limit (2)");

// ---- 5: no early-out, 5<=W<M not past cut-off => Short hours - review ------
clearAll();
addRecord("EMP001", "2099-03-05", "09:00 AM", "03:00 PM"); // 6h, far future => never past cut-off
ok(classify("EMP001", "2099-03-05").classification === "Short hours - review", "5<=W<8 no EO, not past cut-off => Short hours - review");

// ---- 6: no early-out, 5<=W<M past cut-off => Short hours (LOP), idempotent --
clearAll();
addRecord("EMP001", "2020-01-15", "09:00 AM", "03:00 PM"); // 6h, definitely past cut-off
const past = classify("EMP001", "2020-01-15");
ok(past.classification === "Short hours (LOP)" && past.lopFraction === 0.5, "Past cut-off short hours => Short hours (LOP)");
ctx.recalcDayForRecord("EMP001", "2020-01-15");
ctx.recalcDayForRecord("EMP001", "2020-01-15");
ctx.recalcDayForRecord("EMP001", "2020-01-15");
ok(activeLopForDate("EMP001", "2020-01-15") === 1, "Auto half-day LOP is idempotent (exactly one active entry after 3 recalcs)");

// ---- cancel restores balance (over-limit PL released on remove) -------------
clearAll();
addRecord("EMP001", "2026-10-14", "09:00 AM", "04:30 PM");
const eoId = addEarlyOut("EMP001", "2026-10-14", "half-day-leave", "Approved");
// Make 2026-10-14 the 3rd (over-limit) by adding two prior within-limit approved EOs.
addRecord("EMP001", "2026-10-12", "09:00 AM", "04:30 PM"); addEarlyOut("EMP001", "2026-10-12", "half-day-leave", "Approved");
addRecord("EMP001", "2026-10-13", "09:00 AM", "04:30 PM"); addEarlyOut("EMP001", "2026-10-13", "half-day-leave", "Approved");
ctx.recalcDayForRecord("EMP001", "2026-10-14");
const leavesAfterRecalc = ctx.getStore(S.LEAVES, []).filter(l => l.id === `EOPH-EMP001-2026-10-14`).length;
ok(leavesAfterRecalc === 1, "Over-limit half-day-leave EO creates a synthetic 0.5 PL leave");
// Now cancel/remove the approved effect -> should release the PL half and reclassify.
const eoList = ctx.getStore(S.EARLY_OUTS, []);
const target = eoList.find(x => x.id === eoId);
target.status = "Cancelled";
ctx.setStore(S.EARLY_OUTS, eoList);
ctx.removeApprovedEffect("earlyout", target);
const leavesAfterCancel = ctx.getStore(S.LEAVES, []).filter(l => l.id === `EOPH-EMP001-2026-10-14`).length;
ok(leavesAfterCancel === 0, "Cancelling the EO releases the synthetic half-day PL (balance restored)");

// ---- audit log records overrides ------------------------------------------
clearAll();
const auditBefore = ctx.getAuditLog({}).length;
const ov = ctx.applyAdminOverride("EMP001", "2026-10-20", "Manager confirmed on-site work", { id: "ADMIN", name: "Admin", role: "admin" });
const auditAfter = ctx.getAuditLog({}).length;
ok(ov && ov.dayClassification === "Present (Override)", "applyAdminOverride marks the day Present (Override)");
ok(auditAfter === auditBefore + 1, "applyAdminOverride writes exactly one audit entry");
ok(ctx.applyAdminOverride("EMP001", "2026-10-21", "", { id: "ADMIN" }).error === "reason_required", "applyAdminOverride requires a reason");

console.log(`\n=== ${passed} Early Out / Short Leave assertions passed, ${failed} failed ===`);
if (!process.exitCode) console.log(">>> test_early_out: ALL PASS <<<");
