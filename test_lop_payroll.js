/*
 * VKON basic Loss-of-Pay numeric unit tests (Node).
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

// 1) REQUIRED SPEC CASE: salary 50000, 3 LOP days (divisor 30)
//    => deduction 5000.00 and net 45000.00.
const r1 = ctx.computeLopDeduction({ monthlySalary: 50000, lopDays: 3 });
assertClose(r1.lopAmount, 5000.00, "LOP deduction (50000 / 30 * 3)");
assertClose(r1.net, 45000.00, "Net salary (50000 - 5000)");
assertClose(r1.perDaySalary, 1666.67, "Per-day salary rounded for display (50000 / 30)");

// 2) money2 formatting
if (ctx.money2(5000) !== "5000.00" || ctx.money2(45000.5) !== "45000.50") {
  console.error("  FAIL: money2 formatting"); process.exitCode = 1;
} else { console.log("  PASS: money2 => 5000.00 / 45000.50"); passed++; }

// 3) Whole-day LOP (2 days) => 2 x per-day deduction (60000 / 30 * 2).
// LOP is always counted in whole days now (the half-day / 0.5 LOP was removed).
const rTwo = ctx.computeLopDeduction({ monthlySalary: 60000, lopDays: 2 });
assertClose(rTwo.lopAmount, 4000.00, "Whole-day LOP (60000 / 30 * 2)");

// 4) Zero LOP days => no deduction, net equals salary.
const rZero = ctx.computeLopDeduction({ monthlySalary: 50000, lopDays: 0 });
assertClose(rZero.lopAmount, 0, "No LOP days => no deduction");
assertClose(rZero.net, 50000.00, "No LOP days => net equals salary");

// 5) Employee estimate reads monthly_salary off the seeded record.
//    EMP001 is seeded with monthlySalary 50000 => 3 days = 5000.00.
const est = ctx.estimateLopDeduction("EMP001", 3);
assertClose(est.amount, 5000.00, "estimateLopDeduction EMP001 (3 days of 50000)");
assertClose(est.perDaySalary, 1666.67, "estimateLopDeduction per-day salary for EMP001");

console.log(`\n=== ${passed} basic LOP numeric assertions passed ===`);
if (!process.exitCode) console.log(">>> test_lop_payroll: ALL PASS <<<");
