/*
 * VKON getEffectiveStatus() unit tests (Node) — the single source behind the
 * calendar popover, dashboard and admin sheet. Verifies lateness (from shift
 * start + grace), short-by, open-punch handling and the non-punch null case.
 * Defaults: shiftStart 09:30 AM, grace 15m, requiredHours 9. Run: node test_day_popover.js
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

function mk(empId, date, inT, outT, status) {
  return { employeeId: empId, date, status: status || "Present", checkInTime: inT, checkOutTime: outT,
    duration: "-", hoursDecimal: 0, locationType: "Office", bioVerified: true };
}
function put(r) { const rs = ctx.getStore(S.RECORDS, {}); rs[`${r.employeeId}_${r.date}`] = r; ctx.setStore(S.RECORDS, rs); }

// helpers
ok(ctx.parseClockToMinutes("10:50 AM") === 650, "parseClockToMinutes 10:50 AM = 650");
ok(ctx.formatMinutesHM(80) === "1h 20m", "formatMinutesHM(80) = 1h 20m");

// 1. Late from shift start (default): 10:50 in, 9h10 worked -> late, not short
let r1 = mk("E1", "2026-10-20", "10:50 AM", "08:00 PM"); put(r1);
let e1 = ctx.getEffectiveStatus(r1);
ok(e1.late.isLate && e1.late.label === "-1h 20m late", "10:50 in is '-1h 20m late' from 09:30 start");
ok(!e1.short.isShort, "9h10 worked is not short of the 9h requirement");

// 2. Within grace (09:40 <= 09:45) -> On time
let r2 = mk("E2", "2026-10-20", "09:40 AM", "08:00 PM"); put(r2);
ok(!ctx.getEffectiveStatus(r2).late.isLate, "09:40 in (grace 15m) is On time");

// 3. Completed short day: 09:00 -> 04:00 PM (7h) -> Short by 2h 00m, not late
let r3 = mk("E3", "2026-10-20", "09:00 AM", "04:00 PM"); put(r3);
let e3 = ctx.getEffectiveStatus(r3);
ok(!e3.late.isLate, "09:00 in is On time");
ok(e3.short.isShort && e3.short.label === "Short by 2h 00m", "7h worked shows 'Short by 2h 00m'");

// 4. Open punch: no hours counted until check-out; late still shown, short suppressed
let r4 = mk("E4", "2026-10-20", "10:50 AM", "-"); put(r4);
let e4 = ctx.getEffectiveStatus(r4);
ok(e4.isOpen && e4.workedHours === 0, "open punch counts 0 hours until check-out");
ok(e4.late.isLate, "open punch still reports lateness from check-in");
ok(!e4.short.isShort, "open punch is not flagged short (day not complete)");

// 5. lateFrom = graceEnd: 10:50 in measures from 09:45 -> -1h 05m
ctx.setAttendanceSettings({ lateFrom: "graceEnd" });
ok(ctx.getAttendanceSettings().lateFrom === "graceEnd", "lateFrom setting persists");
let e5 = ctx.getEffectiveStatus(r1);
ok(e5.late.label === "-1h 05m late", "graceEnd mode measures late from end of grace");
ctx.setAttendanceSettings({ lateFrom: "shiftStart" }); // restore default

// 6. Non-punch record -> null
ok(ctx.getEffectiveStatus(mk("E6", "2026-10-20", "-", "-", "Absent")) === null, "Absent (non-punch) has no effective status");

// 7. Settings text validation
ok(ctx.setAttendanceSettings({ shiftStart: "8:30 AM" }).shiftStart === "08:30 AM", "shiftStart normalised to 08:30 AM");
ok(ctx.setAttendanceSettings({ shiftStart: "nonsense" }).shiftStart === "08:30 AM", "invalid shiftStart is ignored (keeps last good value)");

console.log(`\n${passed} passed, ${failed} failed`);
