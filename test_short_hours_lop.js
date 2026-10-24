/*
 * VKON Short-Hours / Loss-of-Pay policy-engine unit tests (Node).
 * Loads shared.js inside a minimal localStorage shim so the classification rules
 * can be executed for real (not just grep-checked). Run: `node test_short_hours_lop.js`.
 *
 * The Early Out / Short Leave feature and all half-day (0.5) LOP logic were
 * removed. LOP is now ALWAYS whole-day. Decision table verified
 * (R=9 required, M=8 min-Present, cut-off=1):
 *   W >= M                            -> Present
 *   W <  M, not past payroll cut-off  -> Short hours - review
 *   W <  M, past payroll cut-off      -> Short hours (LOP), 1 whole day
 *   admin override                    -> Present (Override), clears the LOP
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
function addRecord(empId, date, inT, outT) {
  const recs = ctx.getStore(S.RECORDS, {});
  recs[`${empId}_${date}`] = {
    employeeId: empId, date, status: "Present",
    checkInTime: inT, checkOutTime: outT, duration: "-",
    hoursDecimal: 0, locationType: "Office", bioVerified: true
  };
  ctx.setStore(S.RECORDS, recs);
}
function clearAll() {
  ctx.setStore(S.RECORDS, {});
  ctx.setStore(S.LEAVES, []);
  ctx.setStore(S.LOP_ENTRIES, []);
}
function classify(empId, date) { return ctx.classifyDay(empId, date); }
function activeLopForDate(empId, date) {
  return ctx.getLopEntries().filter(e => e.employeeId === empId && e.date === date && e.status === "active");
}

// ---- 0: removed feature is truly gone --------------------------------------
ok(S.EARLY_OUTS === undefined, "STORAGE_KEYS no longer exposes EARLY_OUTS");
ok(C.APPROVAL_TYPES.indexOf("earlyout") === -1, "APPROVAL_TYPES no longer includes 'earlyout'");
ok(C.DEFAULT_APPROVAL_FLOW.earlyout === undefined, "DEFAULT_APPROVAL_FLOW has no earlyout route");
ok(C.DEFAULT_SHORT_LEAVE_SETTINGS.halfDayThresholdHours === undefined &&
   C.DEFAULT_SHORT_LEAVE_SETTINGS.shortLeaveMonthlyLimit === undefined &&
   C.DEFAULT_SHORT_LEAVE_SETTINGS.shortLeaveMaxHoursEach === undefined,
   "Removed half-day / short-leave policy fields are gone from defaults");

// ---- settings persistence --------------------------------------------------
ctx.setAttendanceSettings({ requiredHours: 9, minPresentHours: 8, payrollCutOffDay: 1, graceMinutes: 15 });
const st = ctx.getAttendanceSettings();
ok(st.requiredHours === 9 && st.minPresentHours === 8 && st.payrollCutOffDay === 1 && st.graceMinutes === 15,
   "getAttendanceSettings reflects saved whole-day values");

// ---- 1: at/above minimum => Present ----------------------------------------
clearAll();
addRecord("EMP001", "2026-10-05", "09:00 AM", "06:00 PM"); // 9h
ok(classify("EMP001", "2026-10-05").classification === "Present", "W>=9 => Present");
addRecord("EMP001", "2026-10-06", "09:00 AM", "05:00 PM"); // 8h (== minimum)
ok(classify("EMP001", "2026-10-06").classification === "Present", "W==8 (min) => Present");

// ---- 2: below min, not past cut-off => Short hours - review ----------------
clearAll();
addRecord("EMP001", "2099-03-05", "09:00 AM", "03:00 PM"); // 6h, far future
const review = classify("EMP001", "2099-03-05");
ok(review.classification === "Short hours - review" && review.lopFraction === 0,
   "Below min, before cut-off => Short hours - review (no LOP yet)");

// ---- 3: below min, past cut-off => FULL-day LOP, idempotent ----------------
clearAll();
addRecord("EMP001", "2020-01-15", "09:00 AM", "03:00 PM"); // 6h, definitely past cut-off
const past = classify("EMP001", "2020-01-15");
ok(past.classification === "Short hours (LOP)" && past.lopFraction === 1,
   "Below min, past cut-off => Short hours (LOP) with whole-day fraction 1");
ctx.recalcDayForRecord("EMP001", "2020-01-15");
ctx.recalcDayForRecord("EMP001", "2020-01-15");
ctx.recalcDayForRecord("EMP001", "2020-01-15");
const lopRows = activeLopForDate("EMP001", "2020-01-15");
ok(lopRows.length === 1, "Auto short-hours LOP is idempotent (exactly one active entry after 3 recalcs)");
ok(lopRows[0].fraction === 1 && lopRows[0].source === "short-hours",
   "Auto LOP entry is a whole day (fraction 1, source short-hours)");
ok(ctx.computeLopDaysForMonth("EMP001", "2020-01") === 1, "computeLopDaysForMonth returns a whole number");

// ---- 4: admin override clears the short-hours LOP --------------------------
clearAll();
addRecord("EMP001", "2020-02-10", "09:00 AM", "03:00 PM"); // 6h past cut-off => auto LOP on recalc
ctx.recalcDayForRecord("EMP001", "2020-02-10");
ok(activeLopForDate("EMP001", "2020-02-10").length === 1, "Day has an active short-hours LOP before override");
const ov = ctx.applyAdminOverride("EMP001", "2020-02-10", "Manager confirmed on-site work", { id: "ADMIN", name: "Admin", role: "admin" });
ok(ov && ov.dayClassification === "Present (Override)", "applyAdminOverride marks the day Present (Override)");
ok(activeLopForDate("EMP001", "2020-02-10").length === 0, "Override cancels the auto short-hours LOP");
ok(ctx.applyAdminOverride("EMP001", "2026-02-11", "", { id: "ADMIN" }).error === "reason_required",
   "applyAdminOverride requires a reason");

// ---- 5: a leave LOP is whole-day even when only part of a day --------------
clearAll();
const leave = { id: "LEV-T1", employeeId: "EMP001", status: "Approved", startDate: "2026-06-10", endDate: "2026-06-11" };
ctx.createLopEntriesForLeave(leave);
const leaveLop = ctx.getLopEntries().filter(e => e.source === "leave" && e.status === "active");
ok(leaveLop.length === 2 && leaveLop.every(e => e.fraction === 1),
   "Approved leave creates one whole-day LOP per working day (no 0.5)");

console.log(`\n=== ${passed} Short-Hours / LOP assertions passed, ${failed} failed ===`);
if (!process.exitCode) console.log(">>> test_short_hours_lop: ALL PASS <<<");
