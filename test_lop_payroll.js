/*
 * VKON LOP / Payroll numeric unit tests (Node).
 * Loads shared.js inside a minimal browser shim so the pure money functions can
 * be executed for real (not just grep-checked). Run: `node test_lop_payroll.js`.
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
function assertClose(actual, expected, msg) {
  const ok = Math.abs((Number(actual) || 0) - expected) < 0.005;
  if (!ok) { console.error(`  FAIL: ${msg} (expected ${expected}, got ${actual})`); process.exitCode = 1; }
  else { console.log(`  PASS: ${msg} => ${actual}`); passed++; }
}

const ctx = loadShared();

// 1) REQUIRED SPEC CASE: salary 50000, 31-day month, divisor 30, 3 LOP days
//    => deduction 5000.00 and net 45000.00.
const r1 = ctx.computeLopDeduction({ monthlyGross: 50000, divisor: 30, lopDays: 3, otherDeductions: 0 });
assertClose(r1.lopAmount, 5000.00, "LOP deduction (50000 / 30 * 3)");
assertClose(r1.net, 45000.00, "Net salary (50000 - 5000)");
assertClose(r1.perDayRate, 1666.67, "Per-day rate rounded for display (50000 / 30)");

// 2) money2 formatting
if (ctx.money2(5000) !== "5000.00" || ctx.money2(45000.5) !== "45000.50") {
  console.error("  FAIL: money2 formatting"); process.exitCode = 1;
} else { console.log("  PASS: money2 => 5000.00 / 45000.50"); passed++; }

// 3) Half-day LOP (0.5) => half of a full per-day deduction.
const rHalf = ctx.computeLopDeduction({ monthlyGross: 60000, divisor: 30, lopDays: 0.5 });
assertClose(rHalf.lopAmount, 1000.00, "Half-day LOP (60000 / 30 * 0.5)");

// 4) Calendar divisor mode (Feb 2026 = 28 days).
const calDiv = ctx.lopDivisorValue("calendar", 2026, 1 /* Feb (0-based) */);
assertClose(calDiv, 28, "calendar divisor for Feb 2026");

// 5) Working divisor mode excludes weekends + declared holidays.
const wk = ctx.workingDaysInMonth(2026, 9 /* Oct (0-based) */, new Set(["2026-10-02"]));
if (!(wk >= 18 && wk <= 22)) { console.error("  FAIL: working days sanity for Oct 2026 => " + wk); process.exitCode = 1; }
else { console.log("  PASS: workingDaysInMonth Oct 2026 (excl. 1 holiday) = " + wk); passed++; }

// 6) Pro-rate a mid-month joiner (join 2026-10-16, 31-day month => 16/31 of 62000 = 32000).
const pro = ctx.prorateGross(62000, "2026-10-16", "", 2026, 9);
assertClose(pro, 32000.00, "pro-rated gross for joiner (62000 * 16 / 31)");

// 7) apply LOP on top of the pro-rated gross (32000 / 30 * 1 = 1066.67).
const rPro = ctx.computeLopDeduction({ monthlyGross: pro, divisor: 30, lopDays: 1 });
assertClose(rPro.lopAmount, ctx.round2(32000 / 30), "LOP on pro-rated gross (1 day = 32000 / 30)");

console.log(`\n=== ${passed} LOP/Payroll numeric assertions passed ===`);
if (!process.exitCode) console.log(">>> test_lop_payroll: ALL PASS <<<");
