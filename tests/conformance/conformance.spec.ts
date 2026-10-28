/**
 * tests/conformance/conformance.spec.ts -- decision D2, made executable.
 *
 * For every fixture under tests/fixtures, this runs the SAME logical inputs through BOTH
 * implementations of each rule --
 *     (a) public/shared.js, loaded for real inside a vm with a localStorage shim and a
 *         frozen clock, exactly as the browser runs it today; and
 *     (b) lib/rules (the TypeScript engine the server will use), fed the fixture as a
 *         RuleInputs plus the fixture instant as `now`;
 * -- and fails on the first byte of divergence. `shared === ts` is the mandated property
 * (two truths is the failure mode this whole plan exists to prevent); `ts === expected`
 * additionally pins the hand-computed goldens (the 50000 / 30 * 3 = 5000.00 case, whole-day
 * LOP collapse, holiday-vs-RH) so a shared.js regression cannot become the new "truth".
 *
 * Why the clock is frozen rather than passed: shared.js's classifyDay / getEffectiveStatus
 * / getRegularisationAlerts reach for getNowIST() internally -- the "current time" is part
 * of the ANSWER (an under-worked day is "review" before the payroll cut-off and LOP after
 * it). So the fixture carries an `ist_now` instant, Date.now() is pinned to it in the vm,
 * and the TS side receives the same instant as `now`. Both derive IST the same way, so the
 * comparison holds on any host time zone, not just a +05:30 machine.
 */

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import * as vm from "node:vm";

import * as rules from "../../lib/rules/index";
import { DEFAULT_SETTINGS, DEFAULT_GLOBAL_QUOTAS } from "../../lib/rules/types";
import type { RuleInputs } from "../../lib/rules/types";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..");
const SHARED_PATH = join(ROOT, "public", "shared.js");

// The keys public/shared.js reads out of localStorage. Hardcoded on purpose: a fixture
// that silently started hitting a shared DEFAULT_* fallback (because the harness forgot to
// set a key) would compare the TS empty input against the browser's seeded defaults and
// pass for the wrong reason. Every key is always set.
const KEYS: Record<string, string> = {
  EMPLOYEES: "vkon_employees_v6",
  RECORDS: "vkon_records_v6",
  WFH: "vkon_wfh_v6",
  LEAVES: "vkon_leaves_v6",
  HOLIDAYS: "vkon_holidays_v6",
  REGULARISATIONS: "vkon_regularisations_v6",
  LEAVE_QUOTAS: "vkon_leave_quotas_v6",
  LOP_ENTRIES: "vkon_lop_entries_v1",
  SHORT_LEAVE_SETTINGS: "vkon_short_leave_settings_v1",
  HOLIDAY_WORK: "vkon_holiday_work_v1",
};

interface Fixture {
  name: string;
  ist_now: string;
  settings?: Partial<typeof DEFAULT_SETTINGS>;
  globalQuotas?: Partial<typeof DEFAULT_GLOBAL_QUOTAS>;
  employees?: unknown[];
  records?: Record<string, unknown>;
  leaves?: unknown[];
  wfh?: unknown[];
  regularisations?: unknown[];
  holidays?: unknown[];
  lopEntries?: unknown[];
  holidayWork?: Record<string, unknown>;
  checks: any[];
  expected?: Record<string, unknown>;
}

/** A Date whose "now" is pinned, so shared.js's getNowIST() reads the fixture instant. */
function makeFrozenDate(epochMs: number): typeof Date {
  const fixed = epochMs;
  class FrozenDate extends Date {
    constructor(...args: any[]) {
      // new Date() with no args is the ONLY call that means "now"; every parsed or
      // field-built construction must fall through to the real Date behaviour.
      if (args.length === 0) {
        super(fixed);
      } else {
        super(...args);
      }
    }
    static now(): number {
      return fixed;
    }
  }
  return FrozenDate as unknown as typeof Date;
}

function loadShared(nowEpochMs: number, fixture: Fixture): any {
  const code = readFileSync(SHARED_PATH, "utf8");
  const settings = { ...DEFAULT_SETTINGS, ...(fixture.settings || {}) };
  const quotas = { ...DEFAULT_GLOBAL_QUOTAS, ...(fixture.globalQuotas || {}) };
  const storeContents: Record<string, unknown> = {
    [KEYS.EMPLOYEES]: fixture.employees || [],
    [KEYS.RECORDS]: fixture.records || {},
    [KEYS.WFH]: fixture.wfh || [],
    [KEYS.LEAVES]: fixture.leaves || [],
    [KEYS.HOLIDAYS]: fixture.holidays || [],
    [KEYS.REGULARISATIONS]: fixture.regularisations || [],
    [KEYS.LEAVE_QUOTAS]: quotas,
    [KEYS.LOP_ENTRIES]: fixture.lopEntries || [],
    [KEYS.SHORT_LEAVE_SETTINGS]: settings,
    [KEYS.HOLIDAY_WORK]: fixture.holidayWork || {},
  };

  const store = new Map<string, string>();
  const localStorage = {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => {
      store.set(k, String(v));
    },
    removeItem: (k: string) => {
      store.delete(k);
    },
  };

  const sandbox: any = {
    localStorage,
    console: { log() {}, error() {}, warn() {}, info() {} },
    setTimeout,
    setInterval: () => 0,
    Intl,
    Math,
    JSON,
    Date: makeFrozenDate(nowEpochMs),
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: "shared.js" });
  // IMPORTANT: impose the fixture AFTER load, not before. On load shared.js runs
  // initializeDatabase(), which seeds the demo roster AND mutates whatever is in the store
  // (recalcShortHoursDays writes day classifications, reconcileWfhRecords drops orphan WFH
  // punches, finalizeStaleOpenPunches closes stale shifts). Those are the browser's WRITE
  // paths, not the rules under test. Imposing the fixture last means the rule functions read
  // exactly the pristine inputs the TS side is handed -- which is the only way this compares
  // rules-to-rules rather than rules-plus-hydration.
  for (const [k, v] of Object.entries(storeContents)) store.set(k, JSON.stringify(v));
  return { sandbox, settings, quotas, store };
}

function toRuleInputs(fixture: Fixture): RuleInputs {
  return {
    employees: (fixture.employees || []) as RuleInputs["employees"],
    records: (fixture.records || {}) as RuleInputs["records"],
    leaves: (fixture.leaves || []) as RuleInputs["leaves"],
    wfh: (fixture.wfh || []) as RuleInputs["wfh"],
    regularisations: (fixture.regularisations || []) as RuleInputs["regularisations"],
    holidays: (fixture.holidays || []) as RuleInputs["holidays"],
    lopEntries: (fixture.lopEntries || []) as RuleInputs["lopEntries"],
    holidayWork: (fixture.holidayWork || {}) as RuleInputs["holidayWork"],
    settings: { ...DEFAULT_SETTINGS, ...(fixture.settings || {}) },
    globalQuotas: { ...DEFAULT_GLOBAL_QUOTAS, ...(fixture.globalQuotas || {}) },
  };
}

/** Recursively normalise so the two sides compare structurally: Sets -> sorted arrays. */
function isSetLike(v: any): boolean {
  // The vm runs in its own realm, so a Set returned by shared.js is not `instanceof Set`
  // here. Duck-type on the Set surface (has + add + size) instead of the constructor.
  return (
    !!v &&
    typeof v === "object" &&
    typeof (v as any).has === "function" &&
    typeof (v as any).add === "function" &&
    typeof (v as any).size === "number"
  );
}

function normalize(v: any): any {
  if (Array.isArray(v)) return v.map(normalize);
  if (isSetLike(v)) return Array.from(v as any).map(normalize).sort();
  if (v && typeof v === "object") {
    const out: Record<string, any> = {};
    for (const k of Object.keys(v).sort()) out[k] = normalize(v[k]);
    return out;
  }
  return v;
}

function findEmp(fixture: Fixture, id: string): any {
  return (fixture.employees || []).find((e: any) => e.id === id);
}

// Each check runs against both sides via a tiny dispatch table; the `kind` is the single
// description of the operation, so there is no way for the two sides to be asked subtly
// different questions.
function jsRun(sandbox: any, fixture: Fixture, c: any): any {
  switch (c.kind) {
    case "computeLopDeduction":
      return sandbox.computeLopDeduction(c.opts);
    case "estimateLopDeduction":
      return sandbox.estimateLopDeduction(c.empId, c.lopDays);
    case "getLopDatesForMonth":
      return sandbox.getLopDatesForMonth(c.empId, c.month);
    case "computeLopDaysForMonth":
      return sandbox.computeLopDaysForMonth(c.empId, c.month);
    case "lopDatesForRange":
      return sandbox.lopDatesForRange(c.start, c.end);
    case "countWfhUsedInWeek":
      return sandbox.countWfhUsedInWeek(c.empId, c.weekKey);
    case "employeeLeaveQuota":
      return sandbox.getEmployeeLeaveQuota(c.empId);
    case "approvedLeaveDaysUsed":
      return sandbox.computeApprovedLeaveDaysUsed(c.empId);
    case "approvedPersonalLeaveDaysUsed":
      return sandbox.computeApprovedPersonalLeaveDaysUsed(c.empId);
    case "approvedRestrictedLeaveDaysInMonth":
      return sandbox.computeApprovedRestrictedLeaveDaysInMonth(c.empId, c.year, c.month);
    case "isNonWorkingDay":
      return sandbox.isNonWorkingDay(c.date, c.empId === undefined ? undefined : c.empId);
    case "classifyDay":
      return sandbox.classifyDay(c.empId, c.date);
    case "displayStatusForRecord":
      return sandbox.displayStatusForRecord((fixture.records || {})[c.key]);
    case "getEffectiveStatus":
      return sandbox.getEffectiveStatus(sandbox.getStore(KEYS.RECORDS, {})[c.key]);
    case "getRegularisationAlerts":
      return sandbox.getRegularisationAlerts(findEmp(fixture, c.empId), undefined, undefined);
    default:
      throw new Error(`unknown check kind (js): ${c.kind}`);
  }
}

function tsRun(inputs: RuleInputs, now: Date, fixture: Fixture, c: any): any {
  switch (c.kind) {
    case "computeLopDeduction":
      return rules.computeLopDeduction(c.opts);
    case "estimateLopDeduction":
      return rules.estimateLopDeduction(findEmp(fixture, c.empId), c.lopDays);
    case "getLopDatesForMonth":
      return rules.getLopDatesForMonth(inputs, c.empId, c.month);
    case "computeLopDaysForMonth":
      return rules.computeLopDaysForMonth(inputs, c.empId, c.month);
    case "lopDatesForRange":
      return rules.lopDatesForRange(inputs, c.start, c.end);
    case "countWfhUsedInWeek":
      return rules.countWfhUsedInWeek(inputs, c.empId, c.weekKey);
    case "employeeLeaveQuota":
      return rules.employeeLeaveQuota(inputs, c.empId);
    case "approvedLeaveDaysUsed":
      return rules.approvedLeaveDaysUsed(inputs, c.empId);
    case "approvedPersonalLeaveDaysUsed":
      return rules.approvedPersonalLeaveDaysUsed(inputs, c.empId);
    case "approvedRestrictedLeaveDaysInMonth":
      return rules.approvedRestrictedLeaveDaysInMonth(inputs, c.empId, c.year, c.month);
    case "isNonWorkingDay":
      return rules.isNonWorkingDay(inputs, c.date, c.empId === undefined ? undefined : c.empId);
    case "classifyDay":
      return rules.classifyDay(inputs, c.empId, c.date, now);
    case "displayStatusForRecord":
      return rules.displayStatusForRecord(inputs.records[c.key]);
    case "getEffectiveStatus":
      return rules.getEffectiveStatus(inputs, inputs.records[c.key], now);
    case "getRegularisationAlerts":
      return rules.getRegularisationAlerts(inputs, findEmp(fixture, c.empId), now);
    default:
      throw new Error(`unknown check kind (ts): ${c.kind}`);
  }
}

function fixtures(): Fixture[] {
  const dir = join(ROOT, "tests", "fixtures");
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")) as Fixture);
}

const all = fixtures();
describe("shared.js <-> lib/rules conformance", () => {
  it("found at least one fixture to compare", () => {
    expect(all.length).toBeGreaterThan(0);
  });

  for (const fixture of all) {
    describe(fixture.name, () => {
      const nowEpochMs = Date.parse(fixture.ist_now);
      const { sandbox } = loadShared(nowEpochMs, fixture);
      const inputs = toRuleInputs(fixture);
      const now = new Date(nowEpochMs);

      for (const c of fixture.checks) {
        it(c.id || c.kind, () => {
          const jsOut = normalize(jsRun(sandbox, fixture, c));
          const tsOut = normalize(tsRun(inputs, now, fixture, c));
          // The mandated property: the two implementations agree.
          expect(tsOut).toEqual(jsOut);
          // The golden, when the fixture pins one (so a shared.js regression is caught too).
          if (fixture.expected && Object.prototype.hasOwnProperty.call(fixture.expected, c.id)) {
            expect(tsOut).toEqual(normalize(fixture.expected[c.id]));
          }
        });
      }
    });
  }
});

