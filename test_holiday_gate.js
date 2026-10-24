/*
 * VKON non-working-day (holiday) engine tests (Node).
 * Verifies the single shared isNonWorkingDay() rule and the punch gate that the
 * dashboard, both calendars, the admin counts and the punch service all read:
 *   - declared holidays are off for everyone;
 *   - a restricted holiday is off only for the employee whose RH leave is approved;
 *   - a "Worked on holiday" override reopens punching for that employee + date;
 *   - weekends optionally count as non-working by setting;
 *   - punchBlockedReason() and getNextWorkingDay() agree with the rule.
 * Run: node test_holiday_gate.js
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

// Local YYYY-MM-DD (matches how isNonWorkingDay parses the string in Node tz).
function ymd(d) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; }

// Controlled holiday data (Declared on the 15th, Restricted on the 20th).
ctx.setStore(S.HOLIDAYS, [
  { id: "H1", name: "Republic Day", date: "2026-10-15", type: "Declared Holiday" },
  { id: "H2", name: "Diwali", date: "2026-10-20", type: "Restricted Holiday" }
]);
ctx.setStore(S.LEAVES, []);
ctx.setStore(S.RECORDS, {});
ctx.setStore(S.HOLIDAY_WORK, {});

// 1. Declared holiday is a non-working day for everyone.
ok(ctx.isNonWorkingDay("2026-10-15", "E1") === true, "declared holiday is non-working");
ok(ctx.punchBlockedReason("E1", "2026-10-15") === "Republic Day", "punch rejected on declared holiday, names it");

// 2. Restricted holiday is NOT off unless the employee's RH leave is approved.
ok(ctx.isNonWorkingDay("2026-10-20", "E1") === false, "restricted holiday is working when no approved RH leave");
ok(ctx.punchBlockedReason("E1", "2026-10-20") === null, "punch allowed on un-taken restricted holiday");

// 3. Approve an RH leave for E1 on the 20th -> now non-working for E1 only.
ctx.setStore(S.LEAVES, [{ employeeId: "E1", status: "Approved", category: "Restricted", startDate: "2026-10-20", endDate: "2026-10-20" }]);
ok(ctx.hasApprovedRestrictedLeaveOnDate("E1", "2026-10-20") === true, "approved restricted leave detected for the date");
ok(ctx.isNonWorkingDay("2026-10-20", "E1") === true, "restricted holiday is off for the employee who took it");
ok(ctx.isNonWorkingDay("2026-10-20", "E2") === false, "restricted holiday still a working day for others");

// 4. "Worked on holiday" override reopens punching for that employee + date only.
ctx.setStore(S.LEAVES, []); // clear the RH case
const ov = ctx.markWorkedOnHoliday("E1", "2026-10-15", "Production incident", "extrapay", { id: "ADMIN", role: "admin" });
ok(ov && ov.mode === "extrapay", "markWorkedOnHoliday stores the chosen mode");
ok(ctx.isWorkedOnHoliday("E1", "2026-10-15") === true, "override is recorded");
ok(ctx.isNonWorkingDay("2026-10-15", "E1") === false, "override reopens the day for that employee");
ok(ctx.punchBlockedReason("E1", "2026-10-15") === null, "punch allowed once worked-on-holiday is approved");
ok(ctx.isNonWorkingDay("2026-10-15", "E2") === true, "override is scoped to one employee, not everyone");

// 5. Audit log captured the override.
const audited = ctx.getAuditLog({ action: "worked-on-holiday" }).some(a => a.empId === "E1" && a.date === "2026-10-15");
ok(audited, "override is audit-logged");

// 6. Clearing the override returns the day to non-working.
ctx.clearWorkedOnHoliday("E1", "2026-10-15", { id: "ADMIN", role: "admin" });
ok(ctx.isNonWorkingDay("2026-10-15", "E1") === true, "clearing override hides punching again");

// 7. Next working day skips the holiday and lands on a real working day.
const nx = ctx.getNextWorkingDay("2026-10-15", "E1");
ok(nx && nx.dateStr > "2026-10-15", "next working day is after the holiday");
ok(ctx.isNonWorkingDay(nx.dateStr, "E1") === false, "next working day is genuinely working");

// 8. Weekends are only non-working when the setting is on.
let sat = new Date("2026-10-01T00:00:00");
while (sat.getDay() !== 6) sat.setDate(sat.getDate() + 1);
const satStr = ymd(sat);
ctx.setAttendanceSettings({ treatWeekendsAsNonWorking: false });
ok(ctx.isNonWorkingDay(satStr, "E3") === false, "weekend is a working day by default");
ctx.setAttendanceSettings({ treatWeekendsAsNonWorking: true });
ok(ctx.getAttendanceSettings().treatWeekendsAsNonWorking === true, "weekend setting persists as boolean");
ok(ctx.isNonWorkingDay(satStr, "E3") === true, "weekend is non-working when the setting is on");
ctx.setAttendanceSettings({ treatWeekendsAsNonWorking: false });

// 9. holidayWorkMode coerces to the enum and rejects junk.
ok(ctx.setAttendanceSettings({ holidayWorkMode: "extrapay" }).holidayWorkMode === "extrapay", "holidayWorkMode accepts extrapay");
ok(ctx.setAttendanceSettings({ holidayWorkMode: "bogus" }).holidayWorkMode === "extrapay", "invalid holidayWorkMode is ignored");

console.log(`\n${passed} passed, ${failed} failed`);
