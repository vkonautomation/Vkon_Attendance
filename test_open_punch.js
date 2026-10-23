/*
 * VKON "Present requires check-in AND check-out" tests (Node).
 * Loads shared.js inside a localStorage shim and exercises finalizeStaleOpenPunches
 * for real: a Present/WFH punch left open (no check-out) on a PAST day must become
 * Absent, while today's open punch stays "In Progress" and a completed punch is
 * untouched. Run: `node test_open_punch.js`.
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

function putRecord(empId, date, status, inT, outT) {
  const recs = ctx.getStore(S.RECORDS, {});
  recs[`${empId}_${date}`] = {
    employeeId: empId, date, status,
    checkInTime: inT, checkOutTime: outT,
    duration: outT === "-" ? "In Progress" : "8h", hoursDecimal: outT === "-" ? 0 : 8,
    locationType: "Office", bioVerified: true
  };
  ctx.setStore(S.RECORDS, recs);
}

const today = ctx.formatDateKey(ctx.getNowIST());
const past = "2020-01-02";
const future = "2999-01-02";

// 1. past-day open punch (Present) -> should finalize to Absent
putRecord("EMP001", past, "Present", "11:13 AM", "-");
// 2. past-day open punch (WFH) -> should finalize to Absent too
putRecord("EMP002", past, "WFH", "09:00 AM", "-");
// 3. today's open punch -> must stay Present (In Progress), never auto-absent
putRecord("EMP003", today, "Present", "09:15 AM", "-");
// 4. completed punch (in + out) on a past day -> stays Present, untouched
putRecord("EMP004", past, "Present", "09:00 AM", "06:00 PM");
// 5. a genuine Absent stays Absent
putRecord("EMP005", past, "Absent", "-", "-");
// 6. future-dated open punch -> skipped (date >= today)
putRecord("EMP006", future, "Present", "09:00 AM", "-");

ctx.finalizeStaleOpenPunches();

const r = ctx.getStore(S.RECORDS, {});
ok(r[`EMP001_${past}`].status === "Absent", "past-day open Present punch becomes Absent");
ok(r[`EMP001_${past}`].dayClassification === "Absent", "finalized day is classified Absent");
ok(r[`EMP002_${past}`].status === "Absent", "past-day open WFH punch becomes Absent");
ok(r[`EMP003_${today}`].status === "Present" && ctx.isOpenPunch(r[`EMP003_${today}`]),
   "today's open punch stays Present (In Progress), not auto-absent");
ok(r[`EMP004_${past}`].status === "Present" && !ctx.isOpenPunch(r[`EMP004_${past}`]),
   "completed punch (in + out) remains Present");
ok(r[`EMP005_${past}`].status === "Absent", "an already-Absent day is unchanged");
ok(r[`EMP006_${future}`].status === "Present", "future open punch is left untouched");

// Audit trail recorded the automatic conversion.
const audit = ctx.getAuditLog({ empId: "EMP001", date: past });
ok(audit.some(a => a.action === "open-punch-auto-absent"),
   "auto-absent conversion is written to the audit log");

console.log(`\n${passed} passed, ${failed} failed`);
