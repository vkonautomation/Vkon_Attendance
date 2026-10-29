/**
 * scripts/db-import.mjs -- M11: load a portal Export backup into the relational schema.
 *
 * The static portal's "Export" button (public/js/data-transfer.js) downloads
 * `{_meta, keys:{ "vkon_*": <localStorage value> }}`. This turns those browser
 * documents into normalised rows in the 0002/0003/0004 tables -- the path the
 * database was designed for but that nothing populated yet, and the reason a
 * fresh production box had no `employees` rows and therefore no logins.
 *
 * DRY RUN IS THE DEFAULT. It reads the file, maps every document, and prints the
 * plan plus a confirmation list WITHOUT opening a database connection. This is
 * deliberate: until the real Export file is inspected we want the mapping and its
 * open questions reviewed, not written. `--apply` writes; `--apply --rollback`
 * runs every INSERT inside a transaction and rolls it back, to prove the mapping
 * satisfies the real constraints (CHECKs, FKs, unique indexes) with zero residue.
 *
 * PASSWORD POLICY (owner decision 2026-10-29): an imported person gets a freshly
 * generated ONE-TIME password and `password_change_required = true`. No browser
 * credential is ever read (the Export carries none), no legacy/demo password is
 * reused, and the one-time passwords are written only to a 0600 file named by
 * --credentials-out -- never to stdout, so they cannot leak into a terminal log.
 * `vkon_admin_creds_v6` is ignored: the administrator is created by
 * scripts/db-bootstrap-admin.mjs (db:admin), not by the roster import.
 *
 * Nothing here commits real data; the only sample it is tested against is
 * tests/fixtures/import/attendance-backup.sample.json (synthetic). It lives in a
 * subdirectory so the conformance runner -- which treats every tests/fixtures/*.json
 * as a rules fixture with `checks` -- does not pick it up.
 *
 * Usage:
 *   node scripts/db-import.mjs --file <export.json>            # dry run (default)
 *   node scripts/db-import.mjs --file x.json --dump-plan       # also print the JSON plan
 *   node scripts/db-import.mjs --file x.json --apply --credentials-out /tmp/otp.txt
 *   node scripts/db-import.mjs --file x.json --apply --rollback # schema check, no writes
 */

import { createHash, randomBytes } from "node:crypto";
import { readFileSync, writeFileSync, chmodSync } from "node:fs";
import { createRequire } from "node:module";
import { loadEnvChain } from "./lib/env.mjs";

// ---------------------------------------------------------------- document keys
const K = {
  EMPLOYEES: "vkon_employees_v6",
  RECORDS: "vkon_records_v6",
  WFH: "vkon_wfh_v6",
  LEAVES: "vkon_leaves_v6",
  REGULARISATIONS: "vkon_regularisations_v6",
  HOLIDAYS: "vkon_holidays_v6",
  HOLIDAY_WORK: "vkon_holiday_work_v1",
  LOP: "vkon_lop_entries_v1",
  SETTINGS: "vkon_settings_v6",
  MIN_WORK: "vkon_min_work_policy_v6",
  SHORT_LEAVE: "vkon_short_leave_settings_v1",
  QUOTAS: "vkon_leave_quotas_v6",
};
// Never imported: device/session or display state, or credentials we refuse to reuse.
const IGNORED_DOCS = new Set([
  "vkon_session_v6", "vkon_theme_v6", "vkon_admin_creds_v6",
  "vkon_notifications_v6", "vkon_admin_decision_snap_v6", "vkon_regalert_seen_v1",
  "vkon_approval_flow_v1", // routing defaults already live in migration 0004
]);

// Structural leave kinds (semantic flags only; quota NUMBERS stay NULL -- policy).
const LEAVE_KINDS = [
  { code: "personal_leave", name: "Personal Leave", browser_category: "Personal Leave", alt: ["Personal", "Personal Leave"], paid: true, counts_as_lop: false, sort_order: 10 },
  { code: "sick_leave", name: "Sick Leave", browser_category: "Sick Leave", alt: ["Sick", "Sick Leave"], paid: true, counts_as_lop: false, sort_order: 20 },
  { code: "casual_leave", name: "Casual Leave", browser_category: "Casual Leave", alt: ["Casual", "Casual Leave"], paid: true, counts_as_lop: false, sort_order: 30 },
  { code: "restricted", name: "Restricted Holiday", browser_category: "RH", alt: ["RH", "Restricted", "Restricted Holiday"], paid: true, counts_as_lop: false, sort_order: 40 },
  { code: "loss_of_pay", name: "Loss of Pay", browser_category: "LossOfPay", alt: ["LossOfPay", "Loss of Pay", "Loss of Pay (Unpaid)"], paid: false, counts_as_lop: true, sort_order: 50 },
];

// ---------------------------------------------------------------- owner defaults
// (decision-maker = the owner; these are the stated defaults, not guessed.)
const POLICY = {
  payrollCutOffDay: 1,          // "cut-off day 1 of the next month"
  salaryPerDayDivisor: 30,      // "salary divisor 30"
  graceMinutes: 15,             // "grace period 15 minutes"
  shortLeavePerMonth: 2,        // "short leave 2 per month"
  salaryVisibility: "admin",    // "salary visible to admin only"
  timezone: "Asia/Kolkata",
};

const REQUEST_STATES = new Set([
  "Pending Manager", "Pending Admin", "Approved", "Rejected", "Cancelled", "Cancellation Requested",
]);

// ---------------------------------------------------------------- small helpers
function parseArgs(argv) {
  const get = (name) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : undefined; };
  let file = get("file");
  if (!file) { const pos = argv.find((a) => !a.startsWith("--")); file = pos; }
  return {
    file,
    apply: argv.includes("--apply"),
    rollback: argv.includes("--rollback"),
    dumpPlan: argv.includes("--dump-plan"),
    credentialsOut: get("credentials-out"),
  };
}

function upper(v) { return v == null ? null : String(v).trim().toUpperCase(); }
function lower(v) { return v == null ? null : String(v).trim().toLowerCase(); }
function numOrNull(v) { const n = Number(v); return Number.isFinite(n) ? n : null; }
function nonEmpty(v) { return v != null && String(v).trim() !== "" ? String(v) : null; }

// "09:20 AM" / "9:05" / "06:05 PM" / "-" -> "HH:MM:SS" (24h) or null.
function clockToHms(v) {
  const s = String(v ?? "").trim();
  if (!s || s === "-") return null;
  const m = s.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(am|pm)?$/i);
  if (!m) return null;
  let h = Number(m[1]);
  const min = Number(m[2]);
  const sec = m[3] ? Number(m[3]) : 0;
  const ap = (m[4] || "").toLowerCase();
  if (ap === "pm" && h !== 12) h += 12;
  if (ap === "am" && h === 12) h = 0;
  if (h > 23 || min > 59) return null;
  return `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
}

// An absolute instant: prefer the punch's epoch-ms capture; fall back to the IST
// calendar day + a clock time interpreted at +05:30. Returns ISO or null.
function instantFrom(dayKey, msEpoch, clockHms) {
  const ms = Number(msEpoch);
  if (Number.isFinite(ms) && ms > 0) return new Date(ms).toISOString();
  if (dayKey && clockHms) return `${dayKey}T${clockHms}+05:30`;
  return null;
}

function mapRequestState(browserStatus) {
  const raw = String(browserStatus ?? "").trim();
  if (REQUEST_STATES.has(raw)) return { state: raw, changed: false };
  if (/^pending$/i.test(raw)) return { state: "Pending Manager", changed: true };
  if (/cancel/i.test(raw)) return { state: "Cancelled", changed: true };
  if (/reject/i.test(raw)) return { state: "Rejected", changed: true };
  if (/approv/i.test(raw)) return { state: "Approved", changed: true };
  return { state: "Pending Manager", changed: true };
}

function mapHolidayKind(type) {
  return /restricted/i.test(String(type ?? "")) ? "restricted" : "declared";
}

// ---------------------------------------------------------------- the plan builder
function buildPlan(keys, notes) {
  const flag = (id, msg) => notes.push({ id, msg });

  // --- employees ---
  const roster = Array.isArray(keys[K.EMPLOYEES]) ? keys[K.EMPLOYEES] : [];
  const managerCodes = new Set(roster.map((e) => upper(e.managerId)).filter(Boolean));
  const seenUsernames = new Map();
  let missingEmail = 0, missingUsername = 0, droppedAvatars = 0, inferredManagers = 0;

  const employees = roster.map((e) => {
    const code = upper(e.id);
    let username = lower(e.username);
    if (!username) { missingUsername++; username = code ? code.toLowerCase() : null; }
    if (username) {
      if (seenUsernames.has(username)) flag("username-dup", `username "${username}" used by ${seenUsernames.get(username)} and ${code}`);
      else seenUsernames.set(username, code);
    }
    if (!nonEmpty(e.email)) missingEmail++;
    if (nonEmpty(e.avatar)) droppedAvatars++;
    const role = managerCodes.has(code) ? "manager" : "employee";
    if (role === "manager") inferredManagers++;
    return {
      employee_code: code,
      username,
      name: nonEmpty(e.name) ?? code,
      email: lower(e.email) || null,
      job_title: nonEmpty(e.role) ?? null,     // browser `role` is the DISPLAY job title
      department: nonEmpty(e.department) ?? null,
      role,                                     // auth role, INFERRED (see confirm list)
      monthly_salary: numOrNull(e.monthlySalary),
      geofence_enabled: String(e.geofenceEnforcement ?? "").toLowerCase() !== "exempt",
      active: true,
      joined_on: nonEmpty(e.enrolledAt) ?? null,
      timezone: POLICY.timezone,
      manager_code: upper(e.managerId) || null,
    };
  });

  if (missingEmail) flag("employee.email", `${missingEmail} imported people have NO email -- the Export does not carry one. Confirm the source of addresses or accept NULL.`);
  if (missingUsername) flag("employee.username", `${missingUsername} had no username; derived from employee_code. Confirm the sign-in names.`);
  if (droppedAvatars) flag("employee.avatar_path", `${droppedAvatars} avatars were browser data: URIs; avatar_path stays NULL (the schema stores a path, never bytes).`);
  if (inferredManagers) flag("employee.role", `${inferredManagers} people inferred as 'manager' purely because someone lists them as managerId. The Export has no auth-role field -- confirm each person's real role.`);
  if (roster.some((e) => e.annualLeaveQuota != null)) flag("employee.annualLeaveQuota", "per-employee annualLeaveQuota is NOT a column; leave allowance lives per leave-kind (NULL here). Confirm the quota policy.");

  // --- holidays ---
  const hols = Array.isArray(keys[K.HOLIDAYS]) ? keys[K.HOLIDAYS] : [];
  const holidays = hols.map((h) => ({
    code: nonEmpty(h.id), holiday_date: nonEmpty(h.date),
    name: nonEmpty(h.name), kind: mapHolidayKind(h.type), active: true,
  })).filter((h) => h.code && h.holiday_date && h.name);
  if (hols.some((h) => !/^(Declared|Restricted)\b/i.test(String(h.type ?? ""))))
    flag("holiday.kind", "some holiday.type strings were unrecognised; defaulted to 'declared'. Confirm declared-vs-restricted (LOP suppression depends on it).");

  // --- records (attendance days) ---
  const recsObj = keys[K.RECORDS] && typeof keys[K.RECORDS] === "object" ? keys[K.RECORDS] : {};
  let noIn = 0, noCoords = 0, droppedPhotos = 0;
  const records = Object.values(recsObj).map((r) => {
    const day = nonEmpty(r.date);
    const inClock = clockToHms(r.checkInTime);
    const outClock = clockToHms(r.checkOutTime);
    const check_in_at = instantFrom(day, r.capturedTimestamp, inClock);
    const check_out_at = instantFrom(day, r.outCapturedTimestamp, outClock);
    if (day && !check_in_at) noIn++;
    if (r.checkInLat == null && r.checkInLng == null) noCoords++;
    if (nonEmpty(r.selfieUrl) || nonEmpty(r.outSelfieUrl)) droppedPhotos++;
    return {
      employee_code: upper(r.employeeId),
      attendance_day: day,
      check_in_at, check_out_at,
      status: nonEmpty(r.status),
      location_type: nonEmpty(r.locationType),
      biometric_verified: typeof r.bioVerified === "boolean" ? r.bioVerified : null,
      source: "import",
    };
  }).filter((r) => r.employee_code && r.attendance_day);
  if (noIn) flag("record.time", `${noIn} day(s) have a date but no resolvable punch instant (no capturedTimestamp and an unparseable clock). check_in_at is NULL for those.`);
  if (noCoords) flag("record.coordinates", `${noCoords} record(s) carry no lat/lng -- the Export stores distance/locationType but NOT raw coordinates, so server-side geofence re-evaluation of history is impossible from this file.`);
  if (droppedPhotos) flag("record.photos", `${droppedPhotos} record(s) had punch selfies as data: URIs; photo_path columns stay NULL (paths only, never bytes).`);

  // --- leaves ---
  const leavesIn = Array.isArray(keys[K.LEAVES]) ? keys[K.LEAVES] : [];
  const kindByCat = new Map();
  for (const lk of LEAVE_KINDS) for (const a of [lk.browser_category, ...lk.alt]) kindByCat.set(a.toLowerCase(), lk.code);
  let unmappedKind = 0;
  const leaves = leavesIn.map((l) => {
    const code = upper(l.employeeId);
    const cat = lower(l.category) || lower(l.type);
    const kind_code = kindByCat.get(cat) ?? null;
    if (!kind_code) unmappedKind++;
    const st = mapRequestState(l.status);
    const trail = Array.isArray(l.approvalTrail) ? l.approvalTrail : [];
    const decided = [...trail].reverse().find((t) => /approv|reject/i.test(String(t.state ?? "")));
    return {
      employee_code: code, kind_code, from_date: nonEmpty(l.startDate), to_date: nonEmpty(l.endDate),
      reason: nonEmpty(l.reason) ?? "", _state: st.state, _changed: st.changed,
      _decider_ref: nonEmpty(decided?.actor), _decided_at: nonEmpty(decided?.at), _id: l.id,
    };
  }).filter((x) => x.employee_code && x.kind_code && x.from_date && x.to_date);
  if (unmappedKind) flag("leave.kind_code", `${unmappedKind} leave request(s) had a category that does not map to a known leave-kind. Confirm the category vocabulary.`);

  // --- wfh ---
  const wfhIn = Array.isArray(keys[K.WFH]) ? keys[K.WFH] : [];
  let wfhNoReason = 0;
  const wfh = wfhIn.map((w) => {
    const reason = nonEmpty(w.reason) ?? nonEmpty(w.plan);
    if (!reason) wfhNoReason++;
    const st = mapRequestState(w.status);
    const decided = [...(Array.isArray(w.approvalTrail) ? w.approvalTrail : [])].reverse().find((t) => /approv|reject/i.test(String(t.state ?? "")));
    return {
      employee_code: upper(w.employeeId), work_day: nonEmpty(w.date),
      reason: reason ?? "", plan: nonEmpty(w.plan), _state: st.state,
      _decider_ref: nonEmpty(decided?.actor), _decided_at: nonEmpty(decided?.at),
    };
  }).filter((x) => x.employee_code && x.work_day);
  if (wfhNoReason) flag("wfh.reason", `${wfhNoReason} WFH request(s) carry no reason/plan in the Export; the DB requires a reason (stored as empty string). Confirm whether a default label is acceptable.`);

  // --- regularisations ---
  const regIn = Array.isArray(keys[K.REGULARISATIONS]) ? keys[K.REGULARISATIONS] : [];
  let regKindMapped = 0, regDropped = 0;
  const regularisations = regIn.map((r) => {
    const mt = lower(r.missedType) || "";
    let kind = "both";
    if (/in\b|punch-?in|check-?in/.test(mt)) kind = "missing_check_in";
    else if (/out\b|punch-?out|check-?out/.test(mt)) kind = "missing_check_out";
    if (mt) regKindMapped++;
    const actual_in = clockToHms(r.inTime);
    const actual_out = clockToHms(r.outTime);
    const ok = (kind === "missing_check_in" && actual_in) || (kind === "missing_check_out" && actual_out) || (kind === "both" && actual_in && actual_out);
    if (!ok) { regDropped++; return null; }
    const st = mapRequestState(r.status);
    const decided = [...(Array.isArray(r.approvalTrail) ? r.approvalTrail : [])].reverse().find((t) => /approv|reject/i.test(String(t.state ?? "")));
    return {
      employee_code: upper(r.employeeId), target_date: nonEmpty(r.date), kind, actual_in, actual_out,
      reason: nonEmpty(r.reason) ?? "", _state: st.state,
      _decider_ref: nonEmpty(decided?.actor), _decided_at: nonEmpty(decided?.at),
    };
  }).filter(Boolean);
  if (regDropped) flag("regularisation.kind", `${regDropped} regularisation(s) dropped: the missed-type/times could not satisfy the CHECK (a claim must carry the time it is claiming). Confirm the 'Missed Punch-In/Out/Both' vocabulary.`);

  // --- lop_entries ---
  const lopIn = Array.isArray(keys[K.LOP]) ? keys[K.LOP] : [];
  const LOP_SOURCE = { "leave": "leave", "short-hours": "short-hours", "short hours": "short-hours", "excess": "excess", "import": "import" };
  let lopRefDropped = 0, lopBadSource = 0;
  const lop = lopIn.map((e) => {
    const srcKey = lower(e.source);
    const source = LOP_SOURCE[srcKey] ?? null;
    if (!source) { lopBadSource++; return null; }
    if (nonEmpty(e.refId)) lopRefDropped++;
    return { employee_code: upper(e.employeeId), lop_date: nonEmpty(e.date), source, status: String(e.status ?? "active").toLowerCase() === "cancelled" ? "cancelled" : "active" };
  }).filter(Boolean);
  if (lopRefDropped) flag("lop_entries.ref_id", `${lopRefDropped} LOP entr(y/ies) carry a browser refId (e.g. "LEV-...") that is NOT a uuid; ref_id is imported as NULL. Confirm whether a request cross-reference is required.`);
  if (lopBadSource) flag("lop_entries.source", `${lopBadSource} LOP entr(y/ies) had an unknown source; allowed = leave|short-hours|excess|import.`);

  // --- holiday_work ---
  const hwIn = Array.isArray(keys[K.HOLIDAY_WORK]) ? keys[K.HOLIDAY_WORK] : [];
  let hwBadMode = 0;
  const holidayWork = hwIn.map((h) => {
    const mode = /extra\s*pay|extrapay/i.test(String(h.mode ?? "")) ? "extrapay"
      : /comp|off/i.test(String(h.mode ?? "")) ? "compoff" : null;
    if (!mode) hwBadMode++;
    return { employee_code: upper(h.employeeId), holiday_date: nonEmpty(h.date) ?? nonEmpty(h.holidayDate), mode, note: nonEmpty(h.note) };
  }).filter((x) => x.employee_code && x.holiday_date && x.mode);
  if (hwBadMode) flag("holiday_work.mode", `${hwBadMode} worked-holiday override(s) had a mode outside compoff|extrapay.`);

  // --- settings (owner defaults merged over the Export's knobs) ---
  const g = keys[K.SETTINGS] ?? {};
  const shortLeave = keys[K.SHORT_LEAVE] ?? {};
  const settings = [
    { key: "payroll", value: { cutOffDay: POLICY.payrollCutOffDay, perDayDivisor: POLICY.salaryPerDayDivisor } },
    { key: "attendance.short_leave", value: {
        requiredHours: numOrNull(shortLeave.requiredHours), minPresentHours: numOrNull(shortLeave.minPresentHours),
        payrollCutOffDay: POLICY.payrollCutOffDay, graceMinutes: POLICY.graceMinutes,
        maxPerMonth: POLICY.shortLeavePerMonth, holidayWorkMode: "compoff",
    } },
    { key: "attendance.min_work_policy", value: keys[K.MIN_WORK] ?? null },
    { key: "leave.quotas", value: keys[K.QUOTAS] ?? null },
    { key: "geofence.office", value: { name: nonEmpty(g.officeName), lat: numOrNull(g.officeLat), lng: numOrNull(g.officeLng), radiusMeters: numOrNull(g.geofenceRadiusMeters) ?? 500 } },
    { key: "access.salary", value: { visibility: POLICY.salaryVisibility } },
  ].filter((s) => s.value !== null);
  flag("settings.key-scheme", "settings rows use the seed's dotted keys (payroll, attendance.short_leave, ...). Confirm these are the keys the rule modules (M5/M9) will read, since the live portal still reads the browser documents, not this table.");

  return {
    employees, holidays, records, leaves, wfh, regularisations, lop, holidayWork, settings,
    counts: {
      employees: employees.length, holidays: holidays.length, records: records.length,
      leaves: leaves.length, wfh: wfh.length, regularisations: regularisations.length,
      lop: lop.length, holiday_work: holidayWork.length, settings: settings.length,
      leave_kinds: LEAVE_KINDS.length,
    },
    ignored: Object.keys(keys).filter((k) => IGNORED_DOCS.has(k)),
    unrecognised: Object.keys(keys).filter((k) => !IGNORED_DOCS.has(k) && !Object.values(K).includes(k)),
  };
}

// ---------------------------------------------------------------- dry-run output
function printPlan(plan) {
  console.log("=== DB IMPORT — DRY RUN (nothing written) ===");
  console.log(`mapped rows: ${JSON.stringify(plan.counts)}`);
  if (plan.ignored.length) console.log(`ignored documents: ${plan.ignored.join(", ")}`);
  if (plan.unrecognised.length) console.log(`UNRECOGNISED documents (not imported — confirm): ${plan.unrecognised.join(", ")}`);

  const sample = (arr, n = 1) => arr.slice(0, n).map((x) => JSON.stringify(x));
  console.log(`\n- employees (${plan.counts.employees}):`);
  sample(plan.employees).forEach((s) => console.log(`    ${s}`));
  console.log(`- records   (${plan.counts.records}):`);
  sample(plan.records).forEach((s) => console.log(`    ${s}`));
  console.log(`- leaves    (${plan.counts.leaves}) wfh (${plan.counts.wfh}) regs (${plan.counts.regularisations}) lop (${plan.counts.lop}) holiday_work (${plan.counts.holiday_work}) holidays (${plan.counts.holidays})`);

  console.log("\n=== FIELDS TO CONFIRM FROM THE REAL EXPORT ===");
  for (const n of plan._notes) console.log(`  • [${n.id}] ${n.msg}`);
  console.log("  • [admin] the administrator is NOT created here (run db:admin); vkon_admin_creds_v6 is ignored by design.");
  console.log("  • [passwords] every imported person gets a generated one-time password + forced change; delivered only via --credentials-out.");
}

// ---------------------------------------------------------------- apply (writes)
async function applyPlan(client, plan, bcrypt, cost, out) {
  const preHash = (p) => createHash("sha256").update(p, "utf8").digest("base64");
  const empId = "(SELECT id FROM employees WHERE employee_code = $%d)";

  await client.query("BEGIN");
  try {
    // leave kinds (structural)
    for (const lk of LEAVE_KINDS) {
      await client.query(
        `INSERT INTO leave_kinds (code, name, browser_category, paid, counts_as_lop, requires_proof, annual_quota, sort_order)
         VALUES ($1,$2,$3,$4,$5,FALSE,NULL,$6)
         ON CONFLICT (code) DO UPDATE SET name=EXCLUDED.name, browser_category=EXCLUDED.browser_category,
           paid=EXCLUDED.paid, counts_as_lop=EXCLUDED.counts_as_lop, sort_order=EXCLUDED.sort_order`,
        [lk.code, lk.name, lk.browser_category, lk.paid, lk.counts_as_lop, lk.sort_order],
      );
    }

    // settings
    for (const s of plan.settings) {
      await client.query(
        `INSERT INTO settings (key, value) VALUES ($1, $2::jsonb)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
        [s.key, JSON.stringify(s.value)],
      );
    }

    // employees (+ one-time password, forced change)
    // Fail fast on identity conflicts: ON CONFLICT only covers employee_code, a
    // username owned by a DIFFERENT person would abort mid-transaction with a raw
    // constraint error, and a code that exists under a different username would
    // silently keep the old login while the OTP names the new one.
    const existing = await client.query("SELECT employee_code, username FROM employees");
    const userOwner = new Map(existing.rows.filter((r) => r.username).map((r) => [r.username, r.employee_code]));
    const codeUser = new Map(existing.rows.map((r) => [r.employee_code, r.username]));
    const conflicts = [];
    for (const e of plan.employees) {
      if (!e.username) continue;
      const owner = userOwner.get(e.username);
      if (owner && owner !== e.employee_code)
        conflicts.push(`username "${e.username}" already belongs to ${owner}, not ${e.employee_code}`);
      const held = codeUser.get(e.employee_code);
      if (held && held !== e.username)
        conflicts.push(`${e.employee_code} exists with username "${held}"; the import never renames a login`);
    }
    if (conflicts.length) throw new Error(`pre-import identity conflicts (fix the Export or the roster, nothing was written):\n  - ${conflicts.join("\n  - ")}`);

    const otps = [];
    for (const e of plan.employees) {
      let hash = null;
      if (e.username) {
        const pw = randomBytes(18).toString("base64url");
        hash = await bcrypt.hash(preHash(pw), cost);
        otps.push({ code: e.employee_code, username: e.username, pw });
      }
      await client.query(
        `INSERT INTO employees
           (employee_code, username, name, email, job_title, department, role, monthly_salary,
            geofence_enabled, active, joined_on, timezone, password_hash, password_changed_at, password_change_required)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::text, CASE WHEN $13::text IS NULL THEN NULL ELSE now() END, $14::boolean)
         ON CONFLICT (employee_code) DO UPDATE SET
           name=EXCLUDED.name, job_title=EXCLUDED.job_title, department=EXCLUDED.department,
           monthly_salary=EXCLUDED.monthly_salary, geofence_enabled=EXCLUDED.geofence_enabled,
           active=EXCLUDED.active, joined_on=EXCLUDED.joined_on, timezone=EXCLUDED.timezone,
           email=COALESCE(employees.email, EXCLUDED.email)`,
        [e.employee_code, e.username, e.name, e.email, e.job_title, e.department, e.role,
         e.monthly_salary, e.geofence_enabled, e.active, e.joined_on, e.timezone, hash, !!e.username],
      );
    }

    // manager chain after everyone exists
    for (const e of plan.employees) {
      if (!e.manager_code || e.manager_code === e.employee_code) continue;
      await client.query(
        `UPDATE employees SET manager_id = (SELECT id FROM employees WHERE employee_code = $2)
         WHERE employee_code = $1`,
        [e.employee_code, e.manager_code],
      );
    }

    // holidays
    for (const h of plan.holidays) {
      await client.query(
        `INSERT INTO holidays (code, holiday_date, name, kind, active) VALUES ($1,$2::date,$3,$4,TRUE)
         ON CONFLICT (code) DO UPDATE SET holiday_date=EXCLUDED.holiday_date, name=EXCLUDED.name, kind=EXCLUDED.kind, active=TRUE`,
        [h.code, h.holiday_date, h.name, h.kind],
      );
    }

    // records
    for (const r of plan.records) {
      await client.query(
        `INSERT INTO records (employee_id, attendance_day, check_in_at, check_out_at, status, location_type, biometric_verified, source)
         SELECT id, $2::date, $3::timestamptz, $4::timestamptz, $5, $6, $7, 'import' FROM employees WHERE employee_code = $1
         ON CONFLICT (employee_id, attendance_day) DO NOTHING`,
        [r.employee_code, r.attendance_day, r.check_in_at, r.check_out_at, r.status, r.location_type, r.biometric_verified],
      );
    }

    // leaves (decider must resolve for Approved/Rejected or the CHECK fails -> downgrade)
    for (const l of plan.leaves) {
      const { state, decider, decidedAt } = await resolveDecision(client, l);
      await client.query(
        `INSERT INTO leaves (employee_id, kind_code, from_date, to_date, reason, state, decided_at, decided_by)
         SELECT id, $2, $3::date, $4::date, $5, $6, $7::timestamptz,
                (SELECT id FROM employees WHERE username = $8 OR employee_code = upper($8))
         FROM employees WHERE employee_code = $1
           AND NOT EXISTS (SELECT 1 FROM leaves WHERE employee_id = employees.id AND kind_code = $2
                            AND from_date = $3::date AND to_date = $4::date AND reason = $5)`,
        [l.employee_code, l.kind_code, l.from_date, l.to_date, l.reason, state, decidedAt, decider],
      );
    }

    // wfh
    for (const w of plan.wfh) {
      const { state, decider, decidedAt } = await resolveDecision(client, w);
      await client.query(
        `INSERT INTO wfh (employee_id, work_day, reason, plan, state, decided_at, decided_by)
         SELECT id, $2::date, $3, $4, $5, $6::timestamptz,
                (SELECT id FROM employees WHERE username = $7 OR employee_code = upper($7))
         FROM employees WHERE employee_code = $1
         ON CONFLICT (employee_id, work_day) DO NOTHING`,
        [w.employee_code, w.work_day, w.reason, w.plan, state, decidedAt, decider],
      );
    }

    // regularisations
    for (const r of plan.regularisations) {
      const { state, decider, decidedAt } = await resolveDecision(client, r);
      await client.query(
        `INSERT INTO regularisations (employee_id, target_date, kind, actual_in, actual_out, reason, state, decided_at, decided_by)
         SELECT id, $2::date, $3, $4::time, $5::time, $6, $7, $8::timestamptz,
                (SELECT id FROM employees WHERE username = $9 OR employee_code = upper($9))
         FROM employees WHERE employee_code = $1
         ON CONFLICT (employee_id, target_date) WHERE state IN ('Pending Manager','Pending Admin','Cancellation Requested') DO NOTHING`,
        [r.employee_code, r.target_date, r.kind, r.actual_in, r.actual_out, r.reason, state, decidedAt, decider],
      );
    }

    // lop_entries
    for (const e of plan.lop) {
      await client.query(
        `INSERT INTO lop_entries (employee_id, lop_date, lop_days, source, status)
         SELECT id, $2::date, 1, $3, $4 FROM employees WHERE employee_code = $1
         ON CONFLICT DO NOTHING`,
        [e.employee_code, e.lop_date, e.source, e.status],
      );
    }

    // holiday_work
    for (const h of plan.holidayWork) {
      await client.query(
        `INSERT INTO holiday_work (employee_id, holiday_date, mode, note)
         SELECT id, $2::date, $3, $4 FROM employees WHERE employee_code = $1
         ON CONFLICT (employee_id, holiday_date) DO NOTHING`,
        [h.employee_code, h.holiday_date, h.mode, h.note],
      );
    }

    if (plan._rollback) {
      await client.query("ROLLBACK");
      console.log("[import] --rollback: schema validated, transaction rolled back — NOTHING persisted.");
      if (otps.length) console.log(`[import] ${otps.length} one-time password(s) were generated for the transaction and discarded with it.`);
    } else {
      await client.query("COMMIT");
      console.log("[import] COMMITTED.");
      if (out && otps.length) {
        const body = otps.map((o) => `${o.code}\t${o.username}\t${o.pw}`).join("\n") + "\n";
        writeFileSync(out, body, { mode: 0o600 });
        try { chmodSync(out, 0o600); } catch { /* best effort on Windows */ }
        console.log(`[import] ${otps.length} one-time password(s) written to ${out} (0600). Deliver and destroy.`);
      } else if (!out && otps.length) {
        console.log(`[import] ${otps.length} one-time password(s) were GENERATED but NOT recorded (no --credentials-out). Re-run with --credentials-out or reset passwords via the console.`);
      }
    }
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    err.message = `import rolled back: ${err.message}`;
    throw err;
  }
}

// Resolve a decider for Approved/Rejected; if it cannot be resolved, downgrade the
// state so the CHECK (approved/rejected requires decided_by + decided_at) holds.
async function resolveDecision(client, req) {
  let state = req._state;
  let decider = req._decider_ref ?? null;
  let decidedAt = req._decided_at ?? null;
  if ((state === "Approved" || state === "Rejected") && (!decider || !decidedAt)) {
    // Fall back to the employee's manager, if any.
    const mgr = await client.query(
      `SELECT mu.username AS uname FROM employees e
         LEFT JOIN employees mu ON mu.id = e.manager_id
       WHERE e.employee_code = $1`, [req.employee_code],
    );
    const uname = mgr.rows[0]?.uname ?? null;
    if (uname && decidedAt) decider = uname;
    else if (uname && !decidedAt) { decider = uname; decidedAt = new Date().toISOString(); }
  }
  if ((state === "Approved" || state === "Rejected") && (!decider || !decidedAt)) {
    req._downgraded = true;
    state = "Pending Admin";
    decider = null; decidedAt = null;
  }
  return { state, decider, decidedAt };
}

// ---------------------------------------------------------------- main
async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.file) {
    console.error("usage: node scripts/db-import.mjs --file <export.json> [--apply [--rollback] [--credentials-out <path>]] [--dump-plan]");
    process.exit(2);
  }
  const raw = readFileSync(args.file, "utf8");
  const data = JSON.parse(raw);
  if (!data || typeof data.keys !== "object") throw new Error("not a portal Export backup: missing `keys` object");
  const keys = data.keys;

  const notes = [];
  const plan = buildPlan(keys, notes);
  plan._notes = notes;
  plan._rollback = args.apply && args.rollback;

  printPlan(plan);
  if (args.dumpPlan) console.log("\n--- plan (json) ---\n" + JSON.stringify(plan, (k, v) => (k.startsWith("_") ? undefined : v), 2));

  if (!args.apply) {
    console.log("\n(dry run — re-run with --apply to write; --apply --rollback to validate against the real schema without persisting)");
    return;
  }

  loadEnvChain();
  const cost = Number(process.env.BCRYPT_COST_FACTOR || 11);
  if (!Number.isInteger(cost) || cost < 8 || cost > 14) throw new Error(`BCRYPT_COST_FACTOR must be 8-14, got ${JSON.stringify(process.env.BCRYPT_COST_FACTOR)}`);
  const require = createRequire(import.meta.url);
  const bcrypt = require("bcryptjs");
  const { withOwnerClient } = await import("./lib/db-config.mjs");

  if (!plan._rollback && !args.credentialsOut)
    console.log("[import] NOTE: --apply without --credentials-out will not record one-time passwords.");

  await withOwnerClient((client) => applyPlan(client, plan, bcrypt, cost, args.credentialsOut));
}

main().catch((e) => { console.error(`[import] ERROR: ${e.message}`); process.exit(1); });
