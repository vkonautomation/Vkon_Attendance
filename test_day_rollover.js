// Test: day rollover. Yesterday's unfinished punch must stop being a live shift,
// and the punch card must be rebuilt when midnight passes with the tab open.
const fs = require('fs');
const vm = require('vm');
const code = fs.readFileSync('shared.js', 'utf8');
const sandbox = {
  console, localStorage: {
    _store: {}, getItem(k) { return this._store[k] || null; },
    setItem(k, v) { this._store[k] = v; }, removeItem(k) { delete this._store[k]; }
  }
};
vm.createContext(sandbox);
vm.runInContext(code, sandbox);
sandbox.__consts = vm.runInContext("({ STORAGE_KEYS })", sandbox);
const ctx = vm.runInContext('this', sandbox);
const S = ctx.__consts.STORAGE_KEYS;

let pass = true;
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) pass = false;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
};

// Pin "now" to 11:00 IST on 27 Oct 2026 (05:30Z). The app's own getTodayKey() must
// agree, otherwise the rest of this test proves nothing.
const NOW = Date.parse('2026-10-27T05:30:00Z');
vm.runInContext(`Date.now = () => ${NOW};`, sandbox);
check('the app considers today to be 2026-10-27', ctx.formatDateKey(ctx.getNowIST()), '2026-10-27');

const open = (date) => ({
  employeeId: 'EMP001', name: 'Mukesh Sharma', date,
  checkInTime: '10:42 AM', checkOutTime: '-', duration: 'In Progress',
  hoursDecimal: 0, status: 'Present', capturedTimestamp: date + 'T05:12:00Z'
});
const setRecords = (recs) => sandbox.localStorage.setItem(S.RECORDS, JSON.stringify(recs));
const getRecords = () => JSON.parse(sandbox.localStorage.getItem(S.RECORDS));

// 1. Yesterday's open punch is finalized to Absent.
setRecords({ 'EMP001_2026-10-26': open('2026-10-26') });
ctx.finalizeStaleOpenPunches();
let r = getRecords()['EMP001_2026-10-26'];
check('yesterday\'s open punch is no longer open', ctx.isOpenPunch(r), false);
check('...and is marked Absent', r.status, 'Absent');
check('...with the reason recorded', r.absentReason, 'No check-out recorded');

// 2. Today's open punch is a live shift and must survive.
setRecords({ 'EMP001_2026-10-27': open('2026-10-27') });
ctx.finalizeStaleOpenPunches();
r = getRecords()['EMP001_2026-10-27'];
check('today\'s open punch stays open', ctx.isOpenPunch(r), true);
check('...and stays Present', r.status, 'Present');

// 3. A completed past day is left alone.
const closed = Object.assign(open('2026-10-26'), { checkOutTime: '06:30 PM', duration: '8h 48m', hoursDecimal: 8.8 });
setRecords({ 'EMP001_2026-10-26': closed });
ctx.finalizeStaleOpenPunches();
check('a closed past day is untouched', getRecords()['EMP001_2026-10-26'].status, 'Present');

// 4. Req 8: a punch on a Declared Holiday is never counted Absent, even when it was
// left open. Gandhi Jayanti is the seeded declared holiday in October.
const holiday = '2026-10-02';
check(`${holiday} is a non-working day for this employee`, ctx.isNonWorkingDay(holiday, 'EMP001'), true);
setRecords({ [`EMP001_${holiday}`]: open(holiday) });
ctx.finalizeStaleOpenPunches();
check('an open punch on a declared holiday is left as-is',
  getRecords()[`EMP001_${holiday}`].status, 'Present');

// 5. Regression guard: the clock's day-rollover branch must re-run the reconciliation
// AND repaint the punch card, in that order. Without updatePunchStatus() the card
// keeps offering "Punch Out" for yesterday's shift after midnight.
const appSrc = fs.readFileSync('app.js', 'utf8');
const roll = appSrc.split('if (dayKey !== lastDayKey) {')[1] || '';
const rollEnd = roll.indexOf('\n    }'); // the closing brace of the rollover block
const rollBlock = roll.slice(0, rollEnd > -1 ? rollEnd : 1200);
check('rollover finalizes stale open punches', /finalizeStaleOpenPunches\(\)/.test(rollBlock), true);
check('rollover refreshes the punch card', /updatePunchStatus\(\)/.test(rollBlock), true);
check('rollover reconciles orphan WFH days', /reconcileWfhRecords\(\)/.test(rollBlock), true);
check('punches are finalized before the card is rebuilt',
  rollBlock.indexOf('finalizeStaleOpenPunches()') < rollBlock.indexOf('updatePunchStatus()'), true);

console.log(pass ? '\n--- ALL TESTS PASS ---' : '\n--- SOME TESTS FAILED ---');
process.exit(pass ? 0 : 1);
