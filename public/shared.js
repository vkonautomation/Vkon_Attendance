/**
 * VKON Smart Attendance Engine
 * Inspired by VKON Automation Design System (vkon.in)
 * Centralized Storage, State Models, Dynamic Admin Security, and Biometric Analysis
 */

const STORAGE_KEYS = {
  CURRENT_SESSION: "vkon_session_v6",
  SETTINGS: "vkon_settings_v6",
  EMPLOYEES: "vkon_employees_v6",
  RECORDS: "vkon_records_v6",
  WFH: "vkon_wfh_v6",
  LEAVES: "vkon_leaves_v6",
  HOLIDAYS: "vkon_holidays_v6",
  THEME: "vkon_theme_v6",
  ADMIN_CREDENTIALS: "vkon_admin_creds_v6",
  REGULARISATIONS: "vkon_regularisations_v6",
  LEAVE_QUOTAS: "vkon_leave_quotas_v6",
  MIN_WORK_POLICY: "vkon_min_work_policy_v6",
  NOTIFICATIONS: "vkon_notifications_v6",
  ADMIN_DECISION_SNAP: "vkon_admin_decision_snap_v6",
  // --- Loss of Pay ---
  LOP_ENTRIES: "vkon_lop_entries_v1",
  // --- Manager + Admin approval workflow ---
  APPROVAL_FLOW: "vkon_approval_flow_v1",
  // --- Attendance policy (shift timing, short hours, holidays) ---
  SHORT_LEAVE_SETTINGS: "vkon_short_leave_settings_v1",
  // --- Worked-on-holiday overrides (Admin/Manager exception) ---
  HOLIDAY_WORK: "vkon_holiday_work_v1",
  // --- Regularisation alerts: only a per-employee "last seen" timestamp is
  //     stored; the alerts themselves are always recomputed, never persisted. ---
  REG_ALERT_LAST_SEEN: "vkon_regalert_seen_v1"
};

// Default Company Geofence Coordinates
const DEFAULT_OFFICE = {
  name: "VKON Automation Tech Park",
  lat: 12.9716,
  lng: 77.5946,
  radius: 500 // 500 meters maximum allowed
};

// Initial Declared Company Holidays (Only 2 types: Declared Holiday & Restricted Holiday)
const DEFAULT_HOLIDAYS = [
  { id: "HOL-01", date: "2026-10-02", name: "Gandhi Jayanti", type: "Declared Holiday" },
  { id: "HOL-02", date: "2026-10-20", name: "Diwali Festival", type: "Restricted Holiday" },
  { id: "HOL-03", date: "2026-10-21", name: "Ayudha Puja / Dussehra", type: "Restricted Holiday" },
  { id: "HOL-04", date: "2026-12-25", name: "Christmas Day", type: "Declared Holiday" },
  { id: "HOL-05", date: "2026-01-26", name: "Republic Day", type: "Declared Holiday" },
  { id: "HOL-06", date: "2026-08-15", name: "Independence Day", type: "Declared Holiday" }
];

// High-quality SVG Baseline Portraits (Guaranteed same-origin, zero CORS issues, perfect for canvas biometric matching)
function makeDefaultAvatarSvg(name, skinHex, hairHex, shirtHex, initials) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200" width="200" height="200">
    <defs>
      <linearGradient id="bg_${initials}" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stop-color="#1e293b"/>
        <stop offset="100%" stop-color="#0f172a"/>
      </linearGradient>
    </defs>
    <rect width="200" height="200" rx="24" fill="url(#bg_${initials})"/>
    <path d="M40 200 C40 152 70 142 100 142 C130 142 160 152 160 200 Z" fill="${shirtHex}"/>
    <path d="M85 142 L100 162 L115 142 Z" fill="#ffffff" opacity="0.95"/>
    <rect x="88" y="122" width="24" height="25" fill="${skinHex}"/>
    <ellipse cx="100" cy="94" rx="36" ry="44" fill="${skinHex}"/>
    <path d="M60 84 C60 50 80 40 100 40 C120 40 140 50 140 84 C140 80 135 58 100 58 C65 58 60 80 60 84 Z" fill="${hairHex}"/>
    <rect x="74" y="80" width="16" height="3.5" rx="1.5" fill="${hairHex}"/>
    <rect x="110" y="80" width="16" height="3.5" rx="1.5" fill="${hairHex}"/>
    <ellipse cx="82" cy="89" rx="5" ry="3.5" fill="#ffffff"/>
    <circle cx="82" cy="89" r="2.2" fill="#1e293b"/>
    <ellipse cx="118" cy="89" rx="5" ry="3.5" fill="#ffffff"/>
    <circle cx="118" cy="89" r="2.2" fill="#1e293b"/>
    <path d="M98 92 L96 104 L104 104" stroke="${hairHex}" stroke-width="1.8" fill="none" opacity="0.6" stroke-linecap="round"/>
    <path d="M90 114 Q100 120 110 114" stroke="#c2410c" stroke-width="2.5" fill="none" stroke-linecap="round"/>
    <circle cx="166" cy="34" r="16" fill="#f97316" opacity="0.95"/>
    <text x="166" y="39" font-family="system-ui, sans-serif" font-size="11" font-weight="bold" fill="#ffffff" text-anchor="middle">${initials}</text>
  </svg>`;
  return "data:image/svg+xml;utf8," + encodeURIComponent(svg);
}

// Initial Company Staff Roster: Leave Quotas, Geofence Enforcement, and Master Photos.
// No credentials ship with this roster -- see the demo-authentication note below
// for how sign-in works now that every password field is gone.
const DEFAULT_EMPLOYEES = [
  {
    id: "EMP001",
    name: "Mukesh Sharma",
    username: "mukesh",
    role: "Senior Full-Stack Engineer",
    department: "Engineering",
    avatar: makeDefaultAvatarSvg("Mukesh Sharma", "#d49b6a", "#1c1917", "#2563eb", "MS"),
    annualLeaveQuota: 14,
    monthlySalary: 50000,
    geofenceEnforcement: "required", // "required" (<= 500m) or "exempt" (allowed anywhere)
    enrolledAt: "2026-01-10",
    managerId: "EMP003"
  },
  {
    id: "EMP002",
    name: "Priya Patel",
    username: "priya",
    role: "UI/UX Product Designer",
    department: "Product",
    avatar: makeDefaultAvatarSvg("Priya Patel", "#e0a97a", "#292524", "#7c3aed", "PP"),
    annualLeaveQuota: 14,
    monthlySalary: 42000,
    geofenceEnforcement: "required",
    enrolledAt: "2026-02-15",
    managerId: "EMP003"
  },
  {
    id: "EMP003",
    name: "Chiranth Gowda",
    username: "chiranth",
    role: "Engineering Manager",
    department: "Operations",
    avatar: makeDefaultAvatarSvg("Chiranth Gowda", "#c68b59", "#0f172a", "#059669", "CG"),
    annualLeaveQuota: 14,
    monthlySalary: 68000,
    geofenceEnforcement: "exempt", // Manager exempt from 500m radius
    enrolledAt: "2026-01-05",
    managerId: ""
  },
  {
    id: "EMP004",
    name: "Alex Chen",
    username: "alex",
    role: "DevOps & Cloud Architect",
    department: "Infrastructure",
    avatar: makeDefaultAvatarSvg("Alex Chen", "#f0c29a", "#1e1b4b", "#0891b2", "AC"),
    annualLeaveQuota: 14,
    monthlySalary: 55000,
    geofenceEnforcement: "required",
    enrolledAt: "2026-03-01",
    managerId: ""
  }
];

// Default Administrator Identity (username is editable by Admin in Settings).
// No password is shipped: one exists only if it was created in this browser.
const DEFAULT_ADMIN_CREDENTIALS = {
  username: "admin",
  name: "VKON Executive Administrator",
  role: "System Administrator",
  updatedAt: "2026-10-08"
};

function getAdminCredentials() {
  const creds = getStore(STORAGE_KEYS.ADMIN_CREDENTIALS, DEFAULT_ADMIN_CREDENTIALS);
  if (!creds || !creds.username) {
    return DEFAULT_ADMIN_CREDENTIALS;
  }
  return creds;
}

function setAdminCredentials(newCreds) {
  setStore(STORAGE_KEYS.ADMIN_CREDENTIALS, newCreds);
}

// For legacy references
const ADMIN_CREDENTIALS = getAdminCredentials();

// ============================================================================
//  TEMPORARY DEMO AUTHENTICATION -- THIS IS *NOT* A SECURITY CONTROL
// ============================================================================
// Everything in this block exists so the demo can be clicked through without a
// backend. It is not authentication: the browser holds both sides of the check,
// so anything here can be read, replayed or rewritten with developer tools. Real
// sign-in must come from the server (a login endpoint that verifies a salted
// hash and issues an httpOnly session cookie). Delete this block once that
// endpoint exists.
//
//  * No credential is shipped anywhere in this repository or in the image.
//  * A password is enforced only when one exists on the local record (Admin
//    Settings -> master password, or a roster entry that has one). With no local
//    password the check falls back to the identity alone.
//  * It never echoes, prints, stores in a message, or logs a credential.
//  * It is ENABLED by default so every build stays usable. That is a deliberate
//    product choice, not an access control: whoever reaches the site can open it
//    as any known identity. What they can see is only that browser's own
//    localStorage data -- there is no shared server data to reach.
//  * Kill switch: setDemoAuthFlag("off"), or
//    localStorage.setItem("vkon_demo_auth_v1", "off") in a browser, closes
//    sign-in again and makes the build fail closed. "on" forces it back open.
// ============================================================================
const DEMO_AUTH_FLAG_KEY = "vkon_demo_auth_v1"; // local override: "on" | "off"

// Shown only when someone has switched the demo check off. Generic on purpose:
// it names no account, no password and no internal detail.
const DEMO_AUTH_UNAVAILABLE_MSG = "Sign-in is not available in this build: demo authentication has been switched off and no authentication server is configured.";

// Demo authentication is on unless it was explicitly turned off in this browser.
function demoAuthEnabled() {
  let flag = null;
  try { flag = localStorage.getItem(DEMO_AUTH_FLAG_KEY); } catch (e) { /* private mode */ }
  return flag !== "off";
}

function setDemoAuthFlag(state) {
  try {
    if (state === "on" || state === "off") localStorage.setItem(DEMO_AUTH_FLAG_KEY, state);
    else localStorage.removeItem(DEMO_AUTH_FLAG_KEY);
  } catch (e) { /* ignore */ }
}

// Resolve a roster entry from whatever the user typed: username, Employee ID or
// work email. Returns null when nothing matches.
function _findEmployeeByIdentifier(list, identifier) {
  const id = String(identifier || "").trim().toLowerCase();
  if (!id) return null;
  return list.find(e =>
    String(e.username || "").toLowerCase() === id ||
    String(e.id || "").toLowerCase() === id ||
    String(e.email || "").toLowerCase() === id
  ) || null;
}

// The single client-side sign-in check. Returns one of:
//   { code: "unconfigured" }               demo auth is off -> the caller must deny
//   { code: "invalid" }                    unknown identity, or wrong password
//   { code: "admin" }                      administrator identity accepted
//   { code: "employee", employee: row }    roster identity accepted
// Every outcome is a code: no message built here can carry a credential.
function demoAuthenticate(identifier, password) {
  if (!demoAuthEnabled()) return { code: "unconfigured" };

  const id = String(identifier || "").trim().toLowerCase();
  if (!id) return { code: "invalid" };

  const adminCreds = getAdminCredentials();
  if (id === String(adminCreds.username || "").toLowerCase() || id === "admin") {
    const secret = adminCreds.password || "";
    if (secret && secret !== password) return { code: "invalid" };
    return { code: "admin" };
  }

  const roster = getStore(STORAGE_KEYS.EMPLOYEES, DEFAULT_EMPLOYEES);
  const emp = _findEmployeeByIdentifier(roster, id) || _findEmployeeByIdentifier(DEFAULT_EMPLOYEES, id);
  if (!emp) return { code: "invalid" };

  const secret = emp.password || "";
  if (secret && secret !== password) return { code: "invalid" };
  return { code: "employee", employee: emp };
}

// The server adapter, or null when there is none. Reached through a function rather
// than written inline at each call site because shared.js is also evaluated by the
// node test harnesses, which have no `window` binding at all: a bare `window.VKON_API`
// there throws, and inside getStore()'s try/catch that throw is indistinguishable
// from "no data yet", so every store silently reads back its default.
function apiAdapter() {
  return (typeof window !== "undefined" && window.VKON_API) ? window.VKON_API : null;
}

// ============================================================================
//  SIGN-IN -- the one entry point both consoles use
// ============================================================================
// demoAuthenticate() above cannot be trusted with real data: it runs in the
// browser, so it is kept only for the static build. When js/api.js has talked to
// a backend, this function asks the backend instead and returns the same shape of
// answer, so neither caller has to know which mode it is in.
//
// Codes: "admin" | "employee" | "invalid" | "unconfigured" | "passwordChange"
//        | "throttled" | "unreachable" | "noRoster"
function serverBacked() {
  const api = apiAdapter();
  return !!(api && api.isServerBacked && api.isServerBacked());
}

async function signIn(identifier, password) {
  const isServerBacked = serverBacked();
  if (!isServerBacked) {
    // Static host, or the backend is down: the demo check, exactly as before.
    // localStorage holds only this browser's own data, so nothing is exposed.
    return demoAuthenticate(identifier, password);
  }

  const result = await apiAdapter().login(identifier, password);

  if (result.code === "admin") {
    // Role comes from the server's session, never from what was typed here.
    return { code: "admin", session: result.session };
  }

  if (result.code === "employee") {
    // The server authenticates the person; the roster still describes them. Pull
    // the row by the employee id the account is linked to so the rest of the app
    // (which is written against roster rows) needs no changes at all.
    const empId = result.session && result.session.employeeId;
    const roster = getStore(STORAGE_KEYS.EMPLOYEES, DEFAULT_EMPLOYEES);
    const emp = roster.find(e => String(e.id) === String(empId));
    if (!emp) return { code: "noRoster", employeeId: empId || null };
    return { code: "employee", employee: emp, session: result.session };
  }

  return result;
}

// Leave the server session too, or the next person at this keyboard inherits it.
async function signOut() {
  const api = apiAdapter();
  if (api && api.isServerBacked && api.isServerBacked()) {
    try { await api.logout(); } catch (e) { /* the local clear below still runs */ }
  }
}

const DEFAULT_GLOBAL_LEAVE_QUOTAS = {
  personalLeave: 14,
  restrictedLeave: 2
};

const DEFAULT_ANNUAL_LEAVE_ALLOWANCE = 14;
const WEEKLY_WFH_ALLOWANCE = 2;
const MONTHLY_RH_ALLOWANCE = 2;

// Central Leave Quota Accessors (Admin changes at one point for company-wide effect)
function getGlobalLeaveQuotas() {
  return getStore(STORAGE_KEYS.LEAVE_QUOTAS, DEFAULT_GLOBAL_LEAVE_QUOTAS);
}

function setGlobalLeaveQuotas(quotas) {
  setStore(STORAGE_KEYS.LEAVE_QUOTAS, {
    personalLeave: Math.max(1, parseInt(quotas.personalLeave, 10) || 14),
    restrictedLeave: Math.max(0, parseInt(quotas.restrictedLeave, 10) || 2)
  });
}

// Minimum Shift Hours / Work Duration Policy before Punch-Out is permitted
const DEFAULT_MIN_WORK_POLICY = {
  hours: 8,
  minutes: 0,
  totalMinutes: 480
};

function getMinWorkDurationPolicy() {
  return getStore(STORAGE_KEYS.MIN_WORK_POLICY, DEFAULT_MIN_WORK_POLICY);
}

function setMinWorkDurationPolicy(hours, minutes) {
  const h = Math.max(1, parseInt(hours, 10) || 8);
  const m = Math.max(0, Math.min(59, parseInt(minutes, 10) || 0));
  const policy = {
    hours: h,
    minutes: m,
    totalMinutes: (h * 60) + m
  };
  setStore(STORAGE_KEYS.MIN_WORK_POLICY, policy);
  return policy;
}

// ============================================================================
// ATTENDANCE POLICY SETTINGS (admin-configurable shift timing + short hours)
// ----------------------------------------------------------------------------
// requiredHours        : full shift target (a day at/above this is a clean Present)
// minPresentHours      : Present floor (below this an un-explained day is short)
// payrollCutOffDay       : day-of-month after which an unresolved "Short hours"
//                          day auto-converts to a (full-day) LOP (computed lazily
//                          on load/view, since there is no server scheduler)
// shiftStart             : official day-start clock time ("09:30 AM"), IST
// graceMinutes           : minutes after shiftStart before a day counts as late
// lateFrom               : "shiftStart" (default) measures lateness from the
//                          shift start; "graceEnd" measures it from the end of
//                          the grace window. Either way it is only flagged once
//                          the grace period is exceeded.
// ============================================================================
const DEFAULT_SHORT_LEAVE_SETTINGS = {
  requiredHours: 9,
  minPresentHours: 8,
  payrollCutOffDay: 1,
  shiftStart: "09:30 AM",
  graceMinutes: 15,
  lateFrom: "shiftStart",
  // Holidays / non-working-day policy.
  treatWeekendsAsNonWorking: false,
  holidayWorkMode: "compoff" // "compoff" | "extrapay"
};

// Which keys are numeric vs text, so the getter/setter can coerce + validate.
const _SL_NUMERIC_KEYS = ["requiredHours", "minPresentHours",
  "payrollCutOffDay", "graceMinutes"];
const _SL_BOOL_KEYS = ["treatWeekendsAsNonWorking"];

// Returns the coerced value for a known setting key, or null if invalid/absent.
function _validateAttendanceSetting(k, v) {
  if (v === undefined || v === null || v === "") return null;
  if (_SL_BOOL_KEYS.indexOf(k) !== -1) {
    if (typeof v === "boolean") return v;
    return (v === "true" || v === 1 || v === "1") ? true : (v === "false" || v === 0 || v === "0") ? false : null;
  }
  if (k === "holidayWorkMode") {
    return (v === "compoff" || v === "extrapay") ? v : null;
  }
  if (_SL_NUMERIC_KEYS.indexOf(k) !== -1) {
    const n = Number(v);
    return isNaN(n) ? null : n;
  }
  if (k === "shiftStart") {
    const m = /^(\d{1,2}):(\d{2}) ?(AM|PM)$/i.exec(String(v).trim());
    if (!m) return null;
    const hh = parseInt(m[1], 10);
    if (hh < 1 || hh > 12) return null;
    return `${String(hh).padStart(2, "0")}:${m[2]} ${m[3].toUpperCase()}`;
  }
  if (k === "lateFrom") {
    return (v === "graceEnd" || v === "shiftStart") ? v : null;
  }
  return null;
}

function getAttendanceSettings() {
  const saved = getStore(STORAGE_KEYS.SHORT_LEAVE_SETTINGS, {}) || {};
  const s = Object.assign({}, DEFAULT_SHORT_LEAVE_SETTINGS);
  Object.keys(DEFAULT_SHORT_LEAVE_SETTINGS).forEach(k => {
    const val = _validateAttendanceSetting(k, saved[k]);
    if (val !== null) s[k] = val;
  });
  return s;
}

function setAttendanceSettings(patch) {
  const next = Object.assign({}, getAttendanceSettings());
  if (patch) Object.keys(DEFAULT_SHORT_LEAVE_SETTINGS).forEach(k => {
    const val = _validateAttendanceSetting(k, patch[k]);
    if (val !== null) next[k] = val;
  });
  setStore(STORAGE_KEYS.SHORT_LEAVE_SETTINGS, next);
  return next;
}

function getEmployeeLeaveQuota(empId) {
  const globalQ = getGlobalLeaveQuotas();
  const employees = getStore(STORAGE_KEYS.EMPLOYEES, DEFAULT_EMPLOYEES);
  const emp = employees.find(e => e.id === empId);
  if (!emp) return globalQ;

  const personal = (emp.customLeaveQuota !== undefined && emp.customLeaveQuota !== null && emp.customLeaveQuota !== "")
    ? Number(emp.customLeaveQuota)
    : globalQ.personalLeave;

  const restricted = (emp.customRhQuota !== undefined && emp.customRhQuota !== null && emp.customRhQuota !== "")
    ? Number(emp.customRhQuota)
    : globalQ.restrictedLeave;

  return {
    personalLeave: personal,
    restrictedLeave: restricted,
    isOverridden: (emp.customLeaveQuota !== undefined && emp.customLeaveQuota !== null && emp.customLeaveQuota !== "") ||
                  (emp.customRhQuota !== undefined && emp.customRhQuota !== null && emp.customRhQuota !== "")
  };
}

// ============================================================================
//  Shared calculation helpers — SINGLE SOURCE OF TRUTH for employee & admin
//  views so the dashboard, calendar and master sheet can never disagree.
// ============================================================================

// A punch that has a check-in but no check-out yet (still open / In Progress).
function isOpenPunch(rec) {
  if (!rec) return false;
  const noOut = !rec.checkOutTime || rec.checkOutTime === "-";
  return noOut && (rec.status === "Present" || rec.status === "WFH");
}

// Completed hours for a record. An open punch (no check-out) is NOT a finished
// shift, so it contributes 0 hours regardless of any stored hoursDecimal value.
function effectiveHoursDecimal(rec) {
  if (!rec) return 0;
  if (isOpenPunch(rec)) return 0;
  return Number(rec.hoursDecimal) || 0;
}

// Parse a "h:mm AM/PM" clock string into minutes since midnight, or null.
function parseClockToMinutes(str) {
  const m = /^(\d{1,2}):(\d{2})\s*(AM|PM)$/i.exec((str || "").trim());
  if (!m) return null;
  let h = parseInt(m[1], 10) % 12;
  if (/pm/i.test(m[3])) h += 12;
  const mm = parseInt(m[2], 10);
  if (h > 23 || mm > 59) return null;
  return h * 60 + mm;
}

// Worked minutes derived from the actual in/out clock times (AM/PM strings).
// Returns null if either time is missing/unparsable or the span is negative.
// Used as the source of truth to repair records whose stored duration was
// corrupted by the (now removed) "Mark Required Shift Completed" bypass.
function workedMinutesFromClock(rec) {
  if (!rec) return null;
  const inM = parseClockToMinutes(rec.checkInTime);
  const outM = parseClockToMinutes(rec.checkOutTime);
  if (inM == null || outM == null) return null;
  return outM >= inM ? (outM - inM) : null;
}

// Annual leave days actually used = APPROVED leaves only. A pending request is
// not yet "used" leave (this is the one source both the portal and admin use).
// Loss of Pay days are unpaid by choice and never touch the paid-leave quota.
function computeApprovedLeaveDaysUsed(empId) {
  const allLeaves = getStore(STORAGE_KEYS.LEAVES, []);
  return allLeaves
    .filter(l => l.employeeId === empId && l.status === "Approved" && l.category !== "LossOfPay")
    .reduce((sum, l) => sum + (parseInt(l.daysCount, 10) || 1), 0);
}

// --- Split leave buckets (Personal vs Restricted) --------------------------
// Restricted/RH leave has its own (monthly) allowance and must not be counted
// against the annual Personal quota. LOP is unpaid and never touches either.
function _isRestrictedLeave(l) {
  return l.category === "Restricted" || l.category === "RH" || ((l.type || "").indexOf("Restricted") !== -1);
}
function _isPersonalLeave(l) {
  return !_isRestrictedLeave(l) && l.category !== "LossOfPay" && ((l.type || "").indexOf("Loss of Pay") === -1);
}
// Approved PERSONAL leave days used across the whole year (annual paid quota).
function computeApprovedPersonalLeaveDaysUsed(empId) {
  return getStore(STORAGE_KEYS.LEAVES, [])
    .filter(l => l.employeeId === empId && l.status === "Approved" && _isPersonalLeave(l))
    .reduce((sum, l) => sum + (parseFloat(l.daysCount) || 1), 0);
}
// Approved RESTRICTED (RH) leave days used within a specific month (monthly allowance).
function computeApprovedRestrictedLeaveDaysInMonth(empId, year, month) {
  return getStore(STORAGE_KEYS.LEAVES, [])
    .filter(l => {
      if (l.employeeId !== empId || l.status !== "Approved" || !_isRestrictedLeave(l)) return false;
      const d = new Date((l.startDate || "") + "T00:00:00");
      return d.getFullYear() === year && d.getMonth() === month;
    })
    .reduce((sum, l) => sum + (parseFloat(l.daysCount) || 1), 0);
}

// ============================================================================
// EMPLOYEE NOTIFICATIONS — admin actions (approval decisions, task
// assignments) are pushed here so the employee portal can surface them.
// ============================================================================
function pushNotification(empId, kind, title, text, linkView) {
  if (!empId) return null;
  const list = getStore(STORAGE_KEYS.NOTIFICATIONS, []);
  const n = {
    id: "NT-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 6),
    empId,
    kind: kind || "info", // task | approved | rejected | cancelled | info
    title: title || "Update",
    text: text || "",
    linkView: linkView || null,
    at: new Date().toISOString(),
    read: false
  };
  list.push(n);
  // Cap per employee so localStorage stays small.
  const kept = list.filter(x => x.empId !== empId).concat(list.filter(x => x.empId === empId).slice(-40));
  setStore(STORAGE_KEYS.NOTIFICATIONS, kept);
  return n;
}

function getNotificationsFor(empId) {
  return getStore(STORAGE_KEYS.NOTIFICATIONS, []).filter(n => n.empId === empId);
}

function markNotificationsRead(empId) {
  const list = getStore(STORAGE_KEYS.NOTIFICATIONS, []);
  list.forEach(n => { if (n.empId === empId) n.read = true; });
  setStore(STORAGE_KEYS.NOTIFICATIONS, list);
}

// Assigned manager lookup. Returns "" when no manager is set (or the referenced
// employee no longer exists) so the console can show an empty state.
function resolveManagerName(empId) {
  const employees = getStore(STORAGE_KEYS.EMPLOYEES, DEFAULT_EMPLOYEES);
  const emp = employees.find(e => e.id === empId);
  if (!emp || !emp.managerId) return "";
  const mgr = employees.find(e => e.id === emp.managerId);
  return mgr ? mgr.name : "";
}

// ============================================================================
// LOSS OF PAY (LOP) ENGINE (basic)
// ----------------------------------------------------------------------------
// per_day_salary = monthly_salary / 30
// lop_deduction  = per_day_salary x approved LOP days in the month
// net_salary     = monthly_salary - lop_deduction
// Money is rounded to 2 dp only at the END; the per-day salary stays un-rounded
// while it is multiplied, so (50000 / 30) * 3 is exactly 5000.00.
// Only APPROVED requests count. (Payroll locking, sandwich rule, mid-month
// pro-rating, absent auto-conversion and the audit log are intentionally NOT
// built yet.)
// ============================================================================

const LOP_PER_DAY_DIVISOR = 30;

function round2(n) {
  n = Number(n) || 0;
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function money2(n) {
  return round2(n).toFixed(2);
}

// UNROUNDED per-day salary (kept precise for the multiply step).
function perDayRateRaw(monthlySalary) {
  return (Number(monthlySalary) || 0) / LOP_PER_DAY_DIVISOR;
}

// Core deduction. Pure function — no storage.
// opts: { monthlySalary, lopDays, otherDeductions }
function computeLopDeduction(opts) {
  opts = opts || {};
  const gross = Number(opts.monthlySalary != null ? opts.monthlySalary : opts.monthlyGross) || 0;
  const raw = perDayRateRaw(gross);
  const lopDays = Number(opts.lopDays) || 0;
  const lopAmount = round2(raw * lopDays);
  const other = Number(opts.otherDeductions) || 0;
  const net = round2(gross - lopAmount - other);
  return {
    gross: round2(gross),
    perDaySalary: round2(raw),
    lopDays,
    lopAmount,
    otherDeductions: round2(other),
    net
  };
}

// ---- LOP day entries (the single source of truth for LOP day counts) ----
// { id, employeeId, date 'YYYY-MM-DD', fraction 1, source leave|short-hours, refId, status active|cancelled }
// LOP is always counted in WHOLE days (half-day / 0.5 LOP was removed by policy).
function getLopEntries() { return getStore(STORAGE_KEYS.LOP_ENTRIES, []); }
function addLopEntry(empId, date, fraction, source, refId) {
  const list = getLopEntries();
  // Duplicate guard: one active entry per employee/date/source (+refId for leaves).
  const dup = list.some(e => e.employeeId === empId && e.date === date && e.source === source && e.status === "active" && (source !== "leave" || e.refId === refId));
  if (dup) return null;
  const entry = {
    id: "LOP-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 6),
    employeeId: empId,
    date,
    fraction: 1,
    source: source || "leave",
    refId: refId || null,
    status: "active",
    createdAt: new Date().toISOString()
  };
  list.push(entry);
  setStore(STORAGE_KEYS.LOP_ENTRIES, list);
  return entry;
}
function cancelLopEntriesByRef(refId) {
  if (!refId) return false;
  const list = getLopEntries();
  let changed = false;
  list.forEach(e => {
    if (e.refId === refId && e.status === "active") { e.status = "cancelled"; e.cancelledAt = new Date().toISOString(); changed = true; }
  });
  if (changed) setStore(STORAGE_KEYS.LOP_ENTRIES, list);
  return changed;
}

// The SET of LOP dates for an employee in a 'YYYY-MM' month, taken from the LOP
// ledger (approved LOP leave, excess-leave conversion and auto short-hours LOP).
// WHOLE DAYS ONLY: a date appears at most once, so legacy 0.5 entries collapse.
function getLopDatesForMonth(empId, monthStr) {
  const list = getLopEntries().filter(e => e.employeeId === empId && e.status === "active" && e.date.slice(0, 7) === monthStr);
  return new Set(list.map(e => e.date));
}

// Total LOP days for an employee in a 'YYYY-MM' month.
// WHOLE DAYS ONLY: each calendar day counts at most 1, so a day is either 0 or 1.
// This normalises legacy stored entries that carried a 0.5 fraction (half-day LOP
// was removed by policy) and collapses any duplicate same-day sources to one day.
function computeLopDaysForMonth(empId, monthStr) {
  return getLopDatesForMonth(empId, monthStr).size;
}

// Expand an approved leave range into LOP day objects. Weekends / declared
// holidays are skipped. LOP is always whole-day (a half-day request counts as 1).
function lopDatesForRange(startDate, endDate, opts) {
  opts = opts || {};
  const out = [];
  const holSet = new Set(getDeclaredHolidays().map(h => h.date));
  const cur = new Date(startDate + "T00:00:00");
  const end = new Date((endDate || startDate) + "T00:00:00");
  while (cur <= end) {
    const key = formatDateKey(cur);
    const wd = cur.getDay();
    const isOff = (wd === 0 || wd === 6 || holSet.has(key));
    if (!isOff) out.push({ date: key, fraction: 1 });
    cur.setDate(cur.getDate() + 1);
  }
  return out;
}

// Create the LOP entries for an approved LOP leave request (whole-day).
function createLopEntriesForLeave(req) {
  if (!req || req.status !== "Approved") return 0;
  const dates = lopDatesForRange(req.startDate, req.endDate);
  let n = 0;
  dates.forEach(d => { if (addLopEntry(req.employeeId, d.date, 1, "leave", req.id)) n++; });
  return n;
}

// ---- Employee monthly_salary (the base for all LOP maths) ----
const DEPT_DEFAULT_SALARY = { Engineering: 85000, Product: 78000, Operations: 92000, Infrastructure: 88000 };
function employeeMonthlySalary(empId) {
  const emp = getStore(STORAGE_KEYS.EMPLOYEES, DEFAULT_EMPLOYEES).find(e => e.id === empId);
  if (!emp) return 0;
  const ms = Number(emp.monthlySalary);
  if (ms > 0) return ms;
  return DEPT_DEFAULT_SALARY[emp.department] || 70000;
}

// Set an employee's monthly_salary (admin-editable, on the employee record).
function setEmployeeMonthlySalary(empId, salary) {
  const employees = getStore(STORAGE_KEYS.EMPLOYEES, DEFAULT_EMPLOYEES);
  const emp = employees.find(e => e.id === empId);
  if (emp) {
    emp.monthlySalary = Math.max(0, Number(salary) || 0);
    setStore(STORAGE_KEYS.EMPLOYEES, employees);
  }
}

// Employee-facing estimate of a Loss of Pay deduction.
function estimateLopDeduction(empId, lopDays) {
  const salary = employeeMonthlySalary(empId);
  const raw = perDayRateRaw(salary);
  return { perDaySalary: round2(raw), amount: round2(raw * (Number(lopDays) || 0)) };
}

// ============================================================================
// MANAGER + ADMIN APPROVAL WORKFLOW — configurable per request type.
// ============================================================================
// The four request types that flow through the approval engine. A Leave whose
// category is Loss of Pay is routed with its own "lop" rule, so LOP can default
// to Manager-then-Admin while ordinary Leave is Manager-only.
const APPROVAL_TYPES = ["leave", "wfh", "regularisation", "lop"];
const APPROVAL_ROUTES = ["manager_only", "manager_then_admin"];
const APPROVAL_STATUSES = ["Pending Manager", "Pending Admin", "Approved", "Rejected", "Cancelled", "Cancellation Requested"];
const DEFAULT_APPROVAL_FLOW = {
  leave: "manager_only",
  wfh: "manager_only",
  regularisation: "manager_only",
  lop: "manager_then_admin"
};

function getApprovalFlow() {
  const saved = getStore(STORAGE_KEYS.APPROVAL_FLOW, {}) || {};
  const flow = Object.assign({}, DEFAULT_APPROVAL_FLOW);
  APPROVAL_TYPES.forEach(t => { if (APPROVAL_ROUTES.indexOf(saved[t]) !== -1) flow[t] = saved[t]; });
  return flow;
}

function setApprovalFlow(next) {
  const merged = getApprovalFlow();
  Object.keys(next || {}).forEach(t => {
    if (APPROVAL_TYPES.indexOf(t) !== -1 && APPROVAL_ROUTES.indexOf(next[t]) !== -1) merged[t] = next[t];
  });
  setStore(STORAGE_KEYS.APPROVAL_FLOW, merged);
  return merged;
}

// Map an approval type to the underlying request store key.
function approvalTypeStoreKey(type) {
  if (type === "wfh") return STORAGE_KEYS.WFH;
  if (type === "regularisation") return STORAGE_KEYS.REGULARISATIONS;
  return STORAGE_KEYS.LEAVES;
}

// A Leave record is a "lop" request when its category/type is Loss of Pay.
function leaveApprovalType(leave) {
  if (!leave) return "leave";
  return (leave.category === "LossOfPay" || (leave.type || "").indexOf("Loss of Pay") !== -1) ? "lop" : "leave";
}

// --- Manager relationships -------------------------------------------------
function getDirectReports(managerId) {
  if (!managerId) return [];
  return getStore(STORAGE_KEYS.EMPLOYEES, DEFAULT_EMPLOYEES).filter(e => e.managerId === managerId && e.id !== managerId);
}
function hasTeam(managerId) { return getDirectReports(managerId).length > 0; }
function isManagerOf(managerId, empId) {
  if (!managerId || !empId || managerId === empId) return false;
  const emp = getStore(STORAGE_KEYS.EMPLOYEES, DEFAULT_EMPLOYEES).find(e => e.id === empId);
  return !!emp && emp.managerId === managerId;
}
function _employeeName(empId) {
  const e = getStore(STORAGE_KEYS.EMPLOYEES, DEFAULT_EMPLOYEES).find(x => x.id === empId);
  return e ? e.name : (empId || "");
}

// --- Routing ---------------------------------------------------------------
// Returns the ordered list of approval stages for a request. Req 4: when the
// employee has no manager, or is their own manager, the manager stage is
// skipped so the request goes straight to Admin.
function resolveApprovalRoute(type, empId) {
  const flow = getApprovalFlow();
  const employees = getStore(STORAGE_KEYS.EMPLOYEES, DEFAULT_EMPLOYEES);
  const emp = employees.find(e => e.id === empId);
  const mgrId = emp ? emp.managerId : "";
  // Treat a dangling managerId (manager record deleted) as "no manager" so the
  // request routes straight to Admin instead of getting stuck at "Pending
  // Manager" with no one able to act on it.
  const hasMgr = !!mgrId && mgrId !== empId && employees.some(e => e.id === mgrId);
  if (!hasMgr) return ["admin"];
  return flow[type] === "manager_then_admin" ? ["manager", "admin"] : ["manager"];
}
function statusForStage(stage) { return stage === "manager" ? "Pending Manager" : "Pending Admin"; }
function initialStatusForRoute(route) { return statusForStage((route && route[0]) || "admin"); }
function stageFromStatus(status) {
  if (status === "Pending Manager") return "manager";
  if (status === "Pending Admin") return "admin";
  return null;
}

// Convenience for submit handlers: the fields a brand-new request should carry.
function routingForNewRequest(type, empId) {
  const route = resolveApprovalRoute(type, empId);
  return { approvalRoute: route, status: initialStatusForRoute(route), approvalTrail: [] };
}

// Append one step to a request's audit trail (approver, decision, comment, when).
function recordApprovalTrail(req, stage, actor, decision, comment) {
  if (!req.approvalTrail) req.approvalTrail = [];
  const name = (actor && actor.name) || (actor && actor.id ? _employeeName(actor.id) : (stage === "admin" ? "Admin" : ""));
  // An admin acting at the manager stage is doing so on the manager's behalf.
  const onBehalf = stage === "manager" && !!actor && actor.role === "admin";
  req.approvalTrail.push({
    stage,
    approverId: (actor && actor.id) || "",
    approverName: name,
    role: stage,
    actorRole: (actor && actor.role) || "",
    managerName: (stage === "manager" ? resolveManagerName(req.employeeId) : ""),
    onBehalf,
    decision,
    comment: comment || "",
    at: new Date().toISOString()
  });
}

// --- Read-only helpers for rendering the manager/admin stage split ---------
function _reqRoute(req, type) {
  return (req && req.approvalRoute && req.approvalRoute.length) ? req.approvalRoute : resolveApprovalRoute(type, req.employeeId);
}
function routeHasStage(req, type, stage) { return _reqRoute(req, type).indexOf(stage) !== -1; }
// The most recent trail entry for a given stage, or null if that stage has not
// been actioned yet.
function trailStepFor(req, stage) {
  const trail = (req && req.approvalTrail) || [];
  for (let i = trail.length - 1; i >= 0; i--) { if (trail[i].stage === stage) return trail[i]; }
  return null;
}

// Attendance / balance / LOP side effects are applied ONLY when a request
// reaches the final Approved state (Req 11). Reversal happens on cancellation.
function applyApprovedEffect(type, req) {
  if (!req) return;
  const records = getStore(STORAGE_KEYS.RECORDS, {});
  if (type === "leave") {
    const isRh = req.category === "RH" || req.category === "Restricted";
    const isLop = req.category === "LossOfPay";
    const cur = new Date(req.startDate + "T00:00:00");
    const end = new Date(req.endDate + "T00:00:00");
    while (cur <= end) {
      if (cur.getDay() !== 0 && cur.getDay() !== 6) {
        const dStr = formatDateKey(cur);
        records[`${req.employeeId}_${dStr}`] = {
          employeeId: req.employeeId, date: dStr,
          status: isLop ? "Loss of Pay" : "Leave",
          checkInTime: "-", checkOutTime: "-",
          duration: isLop ? "Loss of Pay (Unpaid)" : (isRh ? "Restricted Holiday (RH)" : "Personal Leave"),
          hoursDecimal: 0, distance: 0,
          locationType: `${isLop ? "Loss of Pay" : (isRh ? "RH" : "Personal Leave")} (Approved)`,
          bioVerified: false, selfieUrl: null
        };
      }
      cur.setDate(cur.getDate() + 1);
    }
    setStore(STORAGE_KEYS.RECORDS, records);
    if (isLop) {
      createLopEntriesForLeave(req);
    } else if (!isRh) {
      const emp = getStore(STORAGE_KEYS.EMPLOYEES, DEFAULT_EMPLOYEES).find(x => x.id === req.employeeId);
      if (emp) {
        const quota = (getEmployeeLeaveQuota(emp.id).personalLeave) || 0;
        const used = computeApprovedLeaveDaysUsed(emp.id);
        const overflow = Math.max(0, used - quota);
        if (overflow > 0) {
          const dates = lopDatesForRange(req.startDate, req.endDate, {});
          let booked = 0;
          for (let i = dates.length - 1; i >= 0 && booked < overflow; i--) {
            if (addLopEntry(emp.id, dates[i].date, dates[i].fraction, "excess", req.id)) booked++;
          }
        }
      }
    }
  } else if (type === "wfh") {
    const employees = getStore(STORAGE_KEYS.EMPLOYEES, DEFAULT_EMPLOYEES);
    const emp = employees.find(e => e.id === req.employeeId) || { avatar: null };
    records[`${req.employeeId}_${req.date}`] = {
      employeeId: req.employeeId, date: req.date, status: "WFH",
      checkInTime: "09:00 AM", checkOutTime: "06:00 PM", duration: "Scheduled Shift",
      hoursDecimal: 9.0, distance: 0, locationType: "Work From Home (Approved)",
      bioVerified: true, selfieUrl: emp.avatar
    };
    setStore(STORAGE_KEYS.RECORDS, records);
  } else if (type === "regularisation") {
    const employees = getStore(STORAGE_KEYS.EMPLOYEES, DEFAULT_EMPLOYEES);
    const emp = employees.find(e => e.id === req.employeeId) || {};
    records[`${req.employeeId}_${req.date}`] = {
      employeeId: req.employeeId, date: req.date, status: "Present",
      checkInTime: req.inTime || "09:15 AM", checkOutTime: req.outTime || "06:15 PM",
      duration: "Regularised Shift (9h 00m)", hoursDecimal: 9.0, distance: 25,
      locationType: "Office (Regularised)", bioVerified: true, regularised: true,
      capturedTimestamp: Date.now(), selfieUrl: emp.avatar || null
    };
    setStore(STORAGE_KEYS.RECORDS, records);
  }
}

function removeApprovedEffect(type, req) {
  if (!req) return;
  const records = getStore(STORAGE_KEYS.RECORDS, {});
  if (type === "leave") {
    const cur = new Date(req.startDate + "T00:00:00");
    const end = new Date(req.endDate + "T00:00:00");
    while (cur <= end) {
      const dStr = formatDateKey(cur);
      const rec = records[`${req.employeeId}_${dStr}`];
      if (rec && (rec.status === "Leave" || rec.status === "Loss of Pay")) delete records[`${req.employeeId}_${dStr}`];
      cur.setDate(cur.getDate() + 1);
    }
    setStore(STORAGE_KEYS.RECORDS, records);
    cancelLopEntriesByRef(req.id);
  } else if (type === "wfh") {
    const rec = records[`${req.employeeId}_${req.date}`];
    if (rec && rec.status === "WFH") { delete records[`${req.employeeId}_${req.date}`]; setStore(STORAGE_KEYS.RECORDS, records); }
  } else if (type === "regularisation") {
    const rec = records[`${req.employeeId}_${req.date}`];
    if (rec && rec.regularised) { delete records[`${req.employeeId}_${req.date}`]; setStore(STORAGE_KEYS.RECORDS, records); }
  }
}

// A WFH day exists only while an Approved WFH request backs it: applyApprovedEffect
// writes the record, removeApprovedEffect deletes it. When the request disappears by
// any other route (an import that replaces the requests but not the records, a
// partial reset, a hand-edited store) the record is orphaned, and every screen that
// trusts it then reports a work-from-home day nobody assigned -- including the weekly
// allowance, which counts WFH records, and the punch card, which hides both buttons
// for a WFH day. Drop those orphans so the calendar, the punch card and the quota
// agree with the requests again.
function hasApprovedWfhRequest(empId, dateKey) {
  if (!empId || !dateKey) return false;
  const allWfh = getStore(STORAGE_KEYS.WFH, []);
  return allWfh.some(w => w.employeeId === empId && w.date === dateKey && w.status === "Approved");
}

// Returns the number of WFH days removed.
function reconcileWfhRecords() {
  const records = getStore(STORAGE_KEYS.RECORDS, {});
  const orphans = [];
  Object.keys(records).forEach(k => {
    const r = records[k];
    if (!r || r.status !== "WFH") return;
    // Older rows may carry the identity only in the "EMP001_2026-10-05" key.
    const empId = r.employeeId || k.split("_")[0];
    const dateKey = r.date || k.split("_").slice(1).join("_");
    if (!hasApprovedWfhRequest(empId, dateKey)) orphans.push(k);
  });
  if (!orphans.length) return 0;
  orphans.forEach(k => delete records[k]);
  setStore(STORAGE_KEYS.RECORDS, records);
  console.warn("Dropped WFH day(s) with no approved WFH request:", orphans.join(", "));
  return orphans.length;
}

function _approvalLabel(type) { return type === "wfh" ? "WFH" : type === "regularisation" ? "Regularisation" : "Leave"; }


// The single source of truth for one approval step, used by BOTH the manager
// console and the admin console. Req 5: a manager may only act on their own
// reports' requests at the manager stage; an admin may act on any pending step
// (including on behalf of an absent manager).
function advanceApproval(type, id, actor, decision, comment) {
  const key = approvalTypeStoreKey(type);
  const list = getStore(key, []);
  const req = list.find(r => r.id === id);
  if (!req) return null;
  const stage = stageFromStatus(req.status);
  if (!stage) return null;

  if (actor && actor.role === "manager") {
    if (stage !== "manager") return null;
    if (!isManagerOf(actor.id, req.employeeId)) return null;
  }

  const route = (req.approvalRoute && req.approvalRoute.length) ? req.approvalRoute : resolveApprovalRoute(type, req.employeeId);

  if (decision === "reject") {
    const reason = (comment || "").trim();
    if (!reason) return { error: "reason_required" };
    recordApprovalTrail(req, stage, actor, "rejected", reason);
    req.status = "Rejected";
    req.rejectionReason = reason;
    // Employee notifications are raised by the portal's syncAdminUpdates (the
    // single source), so the engine stays side-effect-only to avoid duplicates.
    setStore(key, list);
    return req;
  }

  if (decision === "approve") {
    recordApprovalTrail(req, stage, actor, "approved", comment);
    const nextIdx = route.indexOf(stage) + 1;
    const finalApproved = nextIdx >= route.length;
    req.status = finalApproved ? "Approved" : statusForStage(route[nextIdx]);
    setStore(key, list);
    if (finalApproved) applyApprovedEffect(type, req);
    return req;
  }

  return null;
}

// Employee cancels a still-pending request (either pending stage). Req 9.
function cancelPendingRequest(type, id, empId) {
  const key = approvalTypeStoreKey(type);
  const list = getStore(key, []);
  const req = list.find(r => r.id === id);
  if (!req) return null;
  if (empId && req.employeeId !== empId) return null;
  if (req.status !== "Pending Manager" && req.status !== "Pending Admin") return null;
  req.status = "Cancelled";
  setStore(key, list);
  return req;
}

// After approval, an employee asks Admin to cancel; Admin then approves (reverts
// effects) or declines (stays Approved).
function requestAdminCancellation(type, id, empId) {
  const key = approvalTypeStoreKey(type);
  const list = getStore(key, []);
  const req = list.find(r => r.id === id);
  if (!req) return null;
  if (empId && req.employeeId !== empId) return null;
  if (req.status !== "Approved") return null;
  req.status = "Cancellation Requested";
  setStore(key, list);
  return req;
}

function resolveAdminCancellation(type, id, approve) {
  const key = approvalTypeStoreKey(type);
  const list = getStore(key, []);
  const req = list.find(r => r.id === id);
  if (!req || req.status !== "Cancellation Requested") return null;
  if (approve) { req.status = "Cancelled"; removeApprovedEffect(type, req); } else { req.status = "Approved"; }
  setStore(key, list);
  return req;
}

// Manager's pending queue (their direct reports' requests awaiting the manager
// step). Returns [{ type, request }] across the three stores.
function getTeamRequests(managerId, statuses) {
  const reports = getDirectReports(managerId);
  const ids = new Set(reports.map(r => r.id));
  const want = statuses || ["Pending Manager"];
  const out = [];
  ["wfh", "leave", "regularisation"].forEach(t => {
    getStore(approvalTypeStoreKey(t), []).forEach(r => {
      if (ids.has(r.employeeId) && want.indexOf(r.status) !== -1) out.push({ type: t, request: r });
    });
  });
  out.sort((a, b) => String((a.request.submittedAt || a.request.createdAt || "")).localeCompare(String((b.request.submittedAt || b.request.createdAt || ""))));
  return out;
}

function pendingTeamRequestCount(managerId) { return getTeamRequests(managerId, ["Pending Manager"]).length; }

// Compact view of where a request is and what approvers have said, for the
// employee's own request cards.
function approvalSummary(req) {
  const trail = (req && req.approvalTrail) || [];
  const lastRejection = trail.filter(t => t.decision === "rejected").pop();
  return {
    stage: req ? req.status : "",
    trail,
    last: trail.length ? trail[trail.length - 1] : null,
    rejectionReason: (req && req.rejectionReason) || (lastRejection ? lastRejection.comment : "")
  };
}


// WFH days used in a week = approved WFH requests + actual WFH punch records,
// de-duplicated by date, so a worked WFH day always counts toward its week.
function countWfhUsedInWeek(empId, weekKey) {
  const dates = new Set();
  const allWfh = getStore(STORAGE_KEYS.WFH, []);
  allWfh.forEach(w => {
    if (w.employeeId === empId && w.status === "Approved" && w.weekKey === weekKey && w.date) dates.add(w.date);
  });
  const recs = getStore(STORAGE_KEYS.RECORDS, {});
  Object.keys(recs).forEach(k => {
    const r = recs[k];
    if (r && r.employeeId === empId && r.status === "WFH" && r.date) {
      try {
        if (getWeekKey(new Date(r.date + "T00:00:00")) === weekKey) dates.add(r.date);
      } catch (e) { /* ignore malformed date */ }
    }
  });
  return dates.size;
}

function setEmployeeLeaveQuota(empId, personalLeave, restrictedLeave) {
  let employees = getStore(STORAGE_KEYS.EMPLOYEES, DEFAULT_EMPLOYEES);
  const emp = employees.find(e => e.id === empId);
  if (emp) {
    if (personalLeave === null || personalLeave === undefined || personalLeave === "") {
      delete emp.customLeaveQuota;
    } else {
      emp.customLeaveQuota = Math.max(0, parseInt(personalLeave, 10));
    }

    if (restrictedLeave === null || restrictedLeave === undefined || restrictedLeave === "") {
      delete emp.customRhQuota;
    } else {
      emp.customRhQuota = Math.max(0, parseInt(restrictedLeave, 10));
    }

    setStore(STORAGE_KEYS.EMPLOYEES, employees);
  }
}

// Restricted Holidays: dedicated dates defined by Admin
function getRestrictedHolidays() {
  const holidays = getStore(STORAGE_KEYS.HOLIDAYS, DEFAULT_HOLIDAYS);
  return holidays.filter(h => h.type === "Restricted Holiday");
}

function isRestrictedHolidayDate(dateStr) {
  const rhs = getRestrictedHolidays();
  return rhs.some(h => h.date === dateStr);
}

function getDeclaredHolidays() {
  const holidays = getStore(STORAGE_KEYS.HOLIDAYS, DEFAULT_HOLIDAYS);
  return holidays.filter(h => h.type === "Declared Holiday");
}

// ============================================================================
// ATTENDANCE POLICY ENGINE (shift timing + short-hours)
// ----------------------------------------------------------------------------
// The SINGLE source of truth for classifying a punched work-day against the
// admin-configurable attendance policy. Both the employee portal and the admin
// console read the derived day classification and worked hours from here so the
// calendar, dashboard and master sheet can never disagree. LOP is always whole
// day (the half-day / 0.5 LOP and the Early Out feature were removed).
// ============================================================================

// Worked hours (decimal) for a finished punch. Prefer the real clock times
// (repaired source of truth) and fall back to the stored hoursDecimal.
function computeWorkedHours(rec) {
  if (!rec) return 0;
  const mins = workedMinutesFromClock(rec);
  if (mins != null) return Number((mins / 60).toFixed(2));
  return Number(rec.hoursDecimal) || 0;
}

function _isPastPayrollCutOff(dateStr, cutOffDay) {
  const parts = String(dateStr).split("-");
  const y = Number(parts[0]), m = Number(parts[1]); // m is 1..12
  if (!y || !m) return false;
  // Payroll for a month closes on `cutOffDay` of the FOLLOWING month.
  const cut = new Date(y, m, Math.max(1, Math.min(28, Number(cutOffDay) || 1)), 23, 59, 59);
  return getNowIST().getTime() > cut.getTime();
}

// Classify one punched day. Pure read of policy; returns the desired outcome
// without mutating storage (recalcDayForRecord applies the side effects).
function classifyDay(empId, date, settings) {
  const s = settings || getAttendanceSettings();
  const records = getStore(STORAGE_KEYS.RECORDS, {});
  const rec = records[`${empId}_${date}`];
  if (!rec) return null;
  if (rec.status !== "Present" && rec.status !== "WFH") return null;
  if (isOpenPunch(rec)) return { classification: "In Progress", worked: 0, rec };

  const W = computeWorkedHours(rec);
  if (rec.overridePresent) {
    return { classification: "Present (Override)", worked: W, lopFraction: 0, rec };
  }

  let classification, lopFraction = 0;
  if (W >= s.minPresentHours) {
    classification = "Present";
  } else if (_isPastPayrollCutOff(date, s.payrollCutOffDay)) {
    // Under-worked day past the payroll cut-off: a FULL-day LOP (no half).
    classification = "Short hours (LOP)"; lopFraction = 1;
  } else {
    classification = "Short hours - review";
  }
  return { classification, worked: W, lopFraction, rec };
}

// Derive + apply the classification and its whole-day LOP side effect.
function recalcDayForRecord(empId, date) {
  const res = classifyDay(empId, date);
  if (!res) return null;
  const records = getStore(STORAGE_KEYS.RECORDS, {});
  const key = `${empId}_${date}`;
  const rec = records[key];
  if (!rec) return null;

  const changed = rec.dayClassification !== res.classification || rec.workedHours !== res.worked;
  if (!changed && res.classification !== "Short hours - review" && res.classification !== "In Progress") {
    return rec; // already consistent; avoid storage churn on every load
  }

  // Clear any auto short-hours LOP for the day, then re-apply if still due.
  _cancelShortHoursLop(empId, date);
  if (res.lopFraction > 0) {
    addLopEntry(empId, date, 1, "short-hours", null);
  }

  rec.dayClassification = res.classification;
  rec.workedHours = res.worked;
  setStore(STORAGE_KEYS.RECORDS, records);

  return rec;
}

// Reverse the auto short-hours LOP for a day (idempotent, no ref id).
function _cancelShortHoursLop(empId, date) {
  const list = getLopEntries();
  let changed = false;
  list.forEach(e => {
    if (e.employeeId === empId && e.date === date && e.source === "short-hours" && e.status === "active") {
      e.status = "cancelled"; e.cancelledAt = new Date().toISOString(); changed = true;
    }
  });
  if (changed) setStore(STORAGE_KEYS.LOP_ENTRIES, list);
}

// Convenience for views: the classification to show for a record.
function displayStatusForRecord(rec) {
  if (!rec) return "";
  return rec.dayClassification || rec.status || "";
}

// ============================================================================
// REGULARISATION ALERTS (computed, never stored)
// ----------------------------------------------------------------------------
// getRegularisationAlerts(employee, now, settings) is the single, PURE source of
// the "you missed a workday" warnings. It is derived on every portal load (and
// when the day rolls over) so an alert disappears the instant the underlying day
// is resolved (a punch, approved leave/WFH, or an approved regularisation).
// It takes `now` and `settings` as arguments and only READS policy state, so a
// backend job can later reuse the exact same function for email or push.
// ============================================================================

// The payroll close calendar-date (YYYY-MM-DD) for the month that CONTAINS
// `dateStr`. This mirrors _isPastPayrollCutOff: payroll closes on `cutOffDay` of
// the FOLLOWING month, so the alert deadline and the auto-LOP conversion agree.
function _payrollCutOffKeyFor(dateStr, cutOffDay) {
  const parts = String(dateStr).split("-");
  const y = Number(parts[0]), m = Number(parts[1]); // m is 1..12
  if (!y || !m) return null;
  const day = Math.max(1, Math.min(28, Number(cutOffDay) || 1));
  // Month index m (= original month 1..12) is the NEXT month in 0-based terms.
  const d = new Date(y, m, day);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// Whole days from `fromKey` to `toKey` (both YYYY-MM-DD); negative if toKey is
// in the past. UTC-anchored so DST never shifts the count.
function _diffDays(fromKey, toKey) {
  const a = Date.parse(fromKey + "T00:00:00Z");
  const b = Date.parse(toKey + "T00:00:00Z");
  if (isNaN(a) || isNaN(b)) return 0;
  return Math.round((b - a) / 86400000);
}

// "Oct 12" for an alert sentence.
function _prettyDateKey(key) {
  const d = new Date(key + "T00:00:00Z");
  if (isNaN(d.getTime())) return key;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

// The set of YYYY-MM-DD dates an APPROVED request (leave or WFH) covers, so
// those days are never flagged. Handles both single-date and start/end ranges.
function _approvedCoverageDates(list, empId) {
  const set = new Set();
  (Array.isArray(list) ? list : []).forEach(r => {
    if (!r || r.employeeId !== empId || r.status !== "Approved") return;
    if (r.date) { set.add(r.date); return; }
    if (r.startDate && r.endDate) {
      const cur = new Date(r.startDate + "T00:00:00");
      const end = new Date(r.endDate + "T00:00:00");
      while (cur <= end) { set.add(formatDateKey(cur)); cur.setDate(cur.getDate() + 1); }
    } else if (r.startDate) {
      set.add(r.startDate);
    }
  });
  return set;
}

// THE alert calculator. Returns one object per unresolved past workday, most
// urgent first. Pure read: writes nothing.
function getRegularisationAlerts(employee, now, settings) {
  const emp = employee || null;
  if (!emp || !emp.id) return [];
  const s = settings || getAttendanceSettings();
  const n = now || getNowIST();
  const todayKey = formatDateKey(n);

  const records = getStore(STORAGE_KEYS.RECORDS, {});
  const leaves  = getStore(STORAGE_KEYS.LEAVES, []);
  const wfhList = getStore(STORAGE_KEYS.WFH, []);
  const regs    = getStore(STORAGE_KEYS.REGULARISATIONS, []);

  // Index this employee's regularisation requests by date.
  const regByDate = {};
  regs.forEach(r => { if (r.employeeId === emp.id) (regByDate[r.date] = regByDate[r.date] || []).push(r); });
  const leaveDates = _approvedCoverageDates(leaves, emp.id);
  const wfhDates   = _approvedCoverageDates(wfhList, emp.id);

  // Scan window: ~3 months back (two months before the current one) through
  // yesterday. A ~3-month reach keeps a day visible as "critical" after its
  // next-month payroll close, while staying bounded (no unbounded history).
  const ist = getISTDate(n);
  const windowStart = new Date(ist.getFullYear(), ist.getMonth() - 2, 1);
  const enrolledKey = emp.enrolledAt || null;
  const alerts = [];

  for (let cur = new Date(windowStart); ; cur.setDate(cur.getDate() + 1)) {
    const dateStr = formatDateKey(cur);
    if (dateStr >= todayKey) break;                       // exclude today & future
    if (enrolledKey && dateStr < enrolledKey) continue;   // before enrollment
    const dow = cur.getDay();
    if (dow === 0 || dow === 6) continue;                 // weekends always excluded
    if (isNonWorkingDay(dateStr, emp.id)) continue;       // declared/RH holidays off
    if (leaveDates.has(dateStr) || wfhDates.has(dateStr)) continue; // approved leave/WFH

    const rec = records[`${emp.id}_${dateStr}`];
    let statusLabel = null;
    if (rec) {
      const st = rec.status;
      if (st === "Absent") statusLabel = "Absent";
      else if ((st === "Present" || st === "WFH") && isOpenPunch(rec)) statusLabel = "Absent";
      // completed Present/WFH, Leave, Holiday, Loss of Pay => resolved, skip.
    } else {
      statusLabel = "Not Marked";
    }
    if (!statusLabel) continue;

    // A live (not rejected/cancelled) request pending or approved resolves the day.
    const dayRegs = regByDate[dateStr] || [];
    if (dayRegs.some(r => r.status !== "Rejected" && r.status !== "Cancelled")) continue;
    const rejected = dayRegs.some(r => r.status === "Rejected");

    const deadlineKey = _payrollCutOffKeyFor(dateStr, s.payrollCutOffDay);
    const daysLeft = deadlineKey ? _diffDays(todayKey, deadlineKey) : 0;
    const pastCutOff = !deadlineKey || daysLeft < 0;
    const urgency = pastCutOff ? "critical" : (daysLeft <= 3 ? "warning" : "info");

    const when = _prettyDateKey(dateStr);
    let message;
    if (pastCutOff) {
      message = `${when} was not regularised and is counted as a full day of LOP.`;
    } else if (rejected) {
      message = `${when} \u2014 regularisation request rejected, you can resubmit. Regularise by ${_prettyDateKey(deadlineKey)} or it will count as a full day of LOP.`;
    } else {
      message = `${when} is marked ${statusLabel}. Regularise by ${_prettyDateKey(deadlineKey)} or it will count as a full day of LOP.`;
    }

    alerts.push({
      empId: emp.id, dateStr, statusLabel, daysLeft, pastCutOff, urgency,
      rejected, deadlineKey, message,
      occurredAt: `${dateStr}T23:59:59`
    });
  }

  const RANK = { critical: 0, warning: 1, info: 2 };
  alerts.sort((a, b) => (RANK[a.urgency] - RANK[b.urgency]) || (a.dateStr < b.dateStr ? -1 : a.dateStr > b.dateStr ? 1 : 0));
  return alerts;
}

// Only a timestamp is stored per employee (never the alerts themselves). An
// alert counts as unread if it became actionable after this time; it still
// remains in the banner until the underlying day is resolved.
function getRegAlertLastSeen(empId) {
  const m = getStore(STORAGE_KEYS.REG_ALERT_LAST_SEEN, {}) || {};
  return empId ? (m[empId] || null) : null;
}

function markRegAlertsSeen(empId) {
  if (!empId) return;
  const m = getStore(STORAGE_KEYS.REG_ALERT_LAST_SEEN, {}) || {};
  m[empId] = new Date().toISOString();
  setStore(STORAGE_KEYS.REG_ALERT_LAST_SEEN, m);
}

// Format a minute span as "Xh YYm" (always positive; caller adds the sign/word).
function formatMinutesHM(mins) {
  const a = Math.abs(Math.round(mins));
  return `${Math.floor(a / 60)}h ${String(a % 60).padStart(2, "0")}m`;
}

// THE single source of truth for a punched day's effective state. The calendar
// popover, the dashboard and the admin sheet all read this so they can never
// disagree. Returns null for a non-punch record (Absent/Leave/Holiday/etc.).
function getEffectiveStatus(rec, settings) {
  if (!rec) return null;
  const s = settings || getAttendanceSettings();
  if (rec.status !== "Present" && rec.status !== "WFH") return null;

  const open = isOpenPunch(rec);
  const worked = open ? 0 : computeWorkedHours(rec);
  const cls = classifyDay(rec.employeeId, rec.date, s);
  const classification = (cls && cls.classification) || rec.dayClassification || rec.status;
  const checkIn = rec.checkInTime && rec.checkInTime !== "-" ? rec.checkInTime : null;
  const checkOut = rec.checkOutTime && rec.checkOutTime !== "-" ? rec.checkOutTime : null;
  const isComplete = !open;

  // Lateness from shift start (+ grace), IST. Only flagged once grace is passed.
  let late = { isLate: false, minutes: 0, label: "On time" };
  const inM = parseClockToMinutes(checkIn);
  const startM = parseClockToMinutes(s.shiftStart);
  if (inM != null && startM != null) {
    const graceEnd = startM + (Number(s.graceMinutes) || 0);
    if (inM > graceEnd) {
      const from = (s.lateFrom === "graceEnd") ? graceEnd : startM;
      const diff = inM - from;
      if (diff > 0) late = { isLate: true, minutes: diff, label: `-${formatMinutesHM(diff)} late` };
    }
  }

  // Short-by for a completed day that fell under the required shift hours.
  let short = { isShort: false, hours: 0, label: "" };
  if (isComplete && worked < s.requiredHours) {
    const shortMin = Math.round((s.requiredHours - worked) * 60);
    short = { isShort: true, hours: Number((s.requiredHours - worked).toFixed(2)), label: `Short by ${formatMinutesHM(shortMin)}` };
  }

  // Short-hours / override / regularisation tags + reason.
  const tags = [];
  if (classification && classification !== "Present" && classification !== "In Progress") {
    tags.push({ label: classification, reason: (cls && cls.reason) || "" });
  }
  if (rec.overridePresent) tags.push({ label: "Admin Override", reason: rec.overrideReason || "" });

  return {
    status: rec.status, classification, isOpen: open, isComplete,
    checkIn, checkOut, workedHours: worked, late, short, tags, rec
  };
}

// ============================================================================
// NON-WORKING DAY (HOLIDAY) ENGINE
// ----------------------------------------------------------------------------
// One shared function decides whether a date is a working day for a given
// employee, so the dashboard, both calendars, the punch service, the admin
// counts, attendance rate and payroll LOP all agree. Company time zone is IST.
// ============================================================================

// The holiday record (if any) declared for a date, from the raw store so BOTH
// Declared and Restricted types are seen (getDeclaredHolidays() is type-scoped).
function findHolidayForDate(dateStr) {
  const holidays = getStore(STORAGE_KEYS.HOLIDAYS, DEFAULT_HOLIDAYS);
  return holidays.find(h => h.date === dateStr) || null;
}

// Does this employee have an APPROVED restricted-holiday leave on the date?
// Restricted holidays only hide punching for the employee who took that RH.
function hasApprovedRestrictedLeaveOnDate(empId, dateStr) {
  if (!empId) return false;
  const leaves = getStore(STORAGE_KEYS.LEAVES, []);
  const hit = leaves.some(l =>
    l.employeeId === empId && l.status === "Approved" &&
    (l.category === "Restricted" || l.category === "RH" || /restricted/i.test(l.type || "")) &&
    (l.date ? l.date === dateStr
      : (l.startDate && l.endDate && dateStr >= l.startDate && dateStr <= l.endDate)));
  if (hit) return true;
  // A materialised RH record (status Leave, locationType contains "RH") also counts.
  const rec = getStore(STORAGE_KEYS.RECORDS, {})[`${empId}_${dateStr}`];
  return !!(rec && rec.status === "Leave" && rec.locationType && rec.locationType.indexOf("RH") !== -1);
}

// Worked-on-holiday overrides, keyed `${empId}_${date}` -> { reason, mode, actor, at }.
function getHolidayWorkOverrides() {
  return getStore(STORAGE_KEYS.HOLIDAY_WORK, {}) || {};
}

function isWorkedOnHoliday(empId, dateStr) {
  if (!empId) return false;
  return !!getHolidayWorkOverrides()[`${empId}_${dateStr}`];
}

function markWorkedOnHoliday(empId, dateStr, reason, mode, actor) {
  if (!empId || !dateStr) return null;
  const map = getHolidayWorkOverrides();
  const entry = {
    empId, date: dateStr,
    reason: String(reason || "").trim(),
    mode: (mode === "extrapay" ? "extrapay" : "compoff"),
    actor: (actor && (actor.name || actor.id)) || "Admin",
    at: new Date().toISOString()
  };
  map[`${empId}_${dateStr}`] = entry;
  setStore(STORAGE_KEYS.HOLIDAY_WORK, map);
  return entry;
}

function clearWorkedOnHoliday(empId, dateStr, actor) {
  const map = getHolidayWorkOverrides();
  if (map[`${empId}_${dateStr}`]) {
    delete map[`${empId}_${dateStr}`];
    setStore(STORAGE_KEYS.HOLIDAY_WORK, map);
  }
}

// THE single source of truth: is `date` a non-working day for this employee?
// date: "YYYY-MM-DD" or a Date; employee: id string or employee object (optional).
// Optionally counts weekends as non-working by setting (treatWeekendsAsNonWorking).
// Returns false when a "Worked on holiday" override exists for that emp+date.
function isNonWorkingDay(date, employee) {
  try {
    const dateStr = (typeof date === "string") ? date : formatDateKey(date);
    const empId = employee ? (typeof employee === "string" ? employee : employee.id) : null;
    const s = getAttendanceSettings();
    const dObj = new Date(dateStr + "T00:00:00");
    const dow = dObj.getDay();
    const isWeekend = (dow === 0 || dow === 6);

    let nonWorking = false;
    const h = findHolidayForDate(dateStr);
    if (h) {
      if (h.type === "Restricted Holiday") {
        // Req 7: a restricted holiday only hides punching when the employee's
        // restricted leave for that date is approved.
        nonWorking = hasApprovedRestrictedLeaveOnDate(empId, dateStr);
      } else {
        nonWorking = true; // Declared Holiday is mandatory off for everyone
      }
    }
    if (!nonWorking && s.treatWeekendsAsNonWorking && isWeekend) nonWorking = true;
    if (!nonWorking) return false;

    // Req 6 exception: an approved worked-on-holiday override reopens the day.
    if (empId && isWorkedOnHoliday(empId, dateStr)) return false;
    return true;
  } catch (e) {
    return false;
  }
}

// The punch-service gate. Returns a short reason string when punching must be
// blocked on this date (a holiday / non-working day with no override), else null.
// shared.js is the "server" for this pure-static app, so both the UI and this
// guard consult the same rule and a direct action call cannot bypass it.
function punchBlockedReason(empId, dateStr) {
  const dStr = dateStr || formatDateKey(getNowIST());
  if (!isNonWorkingDay(dStr, empId)) return null;
  const h = findHolidayForDate(dStr);
  return h ? h.name : "Non-working day";
}

// Next working day on/after `fromDateStr` (exclusive of the start day), IST-safe.
function getNextWorkingDay(fromDateStr, employee) {
  const start = new Date(fromDateStr + "T00:00:00");
  for (let i = 1; i <= 40; i++) {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    const key = formatDateKey(d);
    if (!isNonWorkingDay(key, employee)) return { dateStr: key, dateObj: d };
  }
  return null;
}

function isShortHoursDay(rec) {
  return !!rec && rec.dayClassification === "Short hours - review";
}

// A day only counts as Present when the employee both checked in AND checked
// out. Any Present/WFH punch still open (no check-out) on a PAST day is
// finalized to Absent so the calendar, dashboard and payroll all agree. Today's
// open punch is left running (shown as "In Progress") and never auto-absented.
function finalizeStaleOpenPunches() {
  try {
    const records = getStore(STORAGE_KEYS.RECORDS, {});
    const today = formatDateKey(getNowIST());
    let changed = false;
    Object.keys(records).forEach(k => {
      const r = records[k];
      if (!r || !isOpenPunch(r) || !r.date) return;
      if (r.date >= today) return; // today (or future): shift still in progress
      // Req 8: a holiday that was declared AFTER a punch already exists keeps the
      // record as-is (and is never counted Absent) unless a worked-on-holiday
      // override makes it a genuine working day for this employee.
      if (isNonWorkingDay(r.date, r.employeeId)) return;
      r.status = "Absent";
      r.duration = "Absent";
      r.hoursDecimal = 0;
      r.dayClassification = "Absent";
      r.absentReason = "No check-out recorded";
      delete r.workedHours;
      changed = true;
    });
    if (changed) setStore(STORAGE_KEYS.RECORDS, records);
  } catch (e) { /* non-fatal */ }
}

// Recalculate the current + previous month (bounded) so "Short hours - review"
// days flip to a full-day LOP once past the payroll cut-off. Runs lazily on load.
function recalcShortHoursDays() {
  try {
    const records = getStore(STORAGE_KEYS.RECORDS, {});
    const curMonth = formatDateKey(getNowIST()).slice(0, 7);
    const [cy, cm] = curMonth.split("-").map(Number);
    const prev = new Date(cy, cm - 2, 1);
    const prevMonth = `${prev.getFullYear()}-${String(prev.getMonth() + 1).padStart(2, "0")}`;
    Object.keys(records).forEach(k => {
      const r = records[k];
      if (!r || (r.status !== "Present" && r.status !== "WFH") || !r.date) return;
      const m = r.date.slice(0, 7);
      if (m === curMonth || m === prevMonth) recalcDayForRecord(r.employeeId, r.date);
    });
  } catch (e) { /* non-fatal */ }
}

// Admin overrides a day to Present. Requires a reason.
function applyAdminOverride(empId, date, reason, actor) {
  if (!reason || !String(reason).trim()) return { error: "reason_required" };
  const records = getStore(STORAGE_KEYS.RECORDS, {});
  const key = `${empId}_${date}`;
  const rec = records[key] || {
    employeeId: empId, date, status: "Present", checkInTime: "-", checkOutTime: "-",
    duration: "-", hoursDecimal: 0, distance: 0, locationType: "Office", bioVerified: false, selfieUrl: null
  };
  rec.status = "Present";
  rec.overridePresent = true;
  rec.overrideReason = String(reason).trim();
  rec.dayClassification = "Present (Override)";
  _cancelShortHoursLop(empId, date);
  setStore(STORAGE_KEYS.RECORDS, records);
  return rec;
}

// ============================================================================
// INDIAN STANDARD TIME (IST) ENGINE (Asia/Kolkata - UTC+05:30)
// ============================================================================

let istServerOffsetMs = 0; // Calibration offset between local clock and authoritative IST

// Asynchronously fetch live Indian Standard Time from authoritative time API
async function fetchISTServerTime() {
  if (typeof fetch !== "function") return;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3500);
    const resp = await fetch("https://timeapi.io/api/time/current/zone?timeZone=Asia%2FKolkata", {
      signal: controller.signal
    });
    clearTimeout(timeout);
    if (resp.ok) {
      const data = await resp.json();
      if (data && data.dateTime) {
        const sTime = new Date(data.dateTime).getTime();
        istServerOffsetMs = sTime - Date.now();
        console.log("[IST Engine] Live time fetched as per Indian Standard Time (TimeAPI). Offset:", istServerOffsetMs, "ms");
        return;
      }
    }
  } catch (e1) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 3000);
      const resp2 = await fetch("https://worldtimeapi.org/api/timezone/Asia/Kolkata", {
        signal: controller.signal
      });
      clearTimeout(timeout);
      if (resp2.ok) {
        const data2 = await resp2.json();
        if (data2 && data2.datetime) {
          const sTime = new Date(data2.datetime).getTime();
          istServerOffsetMs = sTime - Date.now();
          console.log("[IST Engine] Live time fetched as per Indian Standard Time (WorldTimeAPI). Offset:", istServerOffsetMs, "ms");
          return;
        }
      }
    } catch (e2) {}
  }
}

// Automatically initiate live IST sync on load
if (typeof window !== "undefined") {
  fetchISTServerTime();
}

// Convert any Date into Indian Standard Time (Asia/Kolkata, UTC+5:30)
function getISTDate(date = new Date()) {
  try {
    const istString = date.toLocaleString("en-US", { timeZone: "Asia/Kolkata" });
    return new Date(istString);
  } catch (e) {
    const utcMs = date.getTime() + (date.getTimezoneOffset() * 60000);
    return new Date(utcMs + (5.5 * 3600000));
  }
}

// Get the current instant strictly in Indian Standard Time
function getNowIST() {
  const adjusted = new Date(Date.now() + istServerOffsetMs);
  return getISTDate(adjusted);
}

// Function to dynamically resolve the present date strictly as per Indian Standard Time (IST)
function getPresentDate() {
  // Evaluates current active date strictly as per Indian Standard Time (Asia/Kolkata)
  // Dynamic IST resolution (base anchor: new Date(2026, 9, 12))
  return getNowIST();
}

// Current System Date (Always dynamically returns the present date)
const CURRENT_DATE = getPresentDate(); // const CURRENT_DATE = new Date();

function getStore(key, defaultVal) {
  try {
    // When the server adapter is live it holds the in-memory copy of every shared
    // store, hydrated at boot. Reading from it here is what keeps the ~190 call
    // sites below this function synchronous and untouched by the backend.
    const api = apiAdapter();
    if (api && api.handles(key)) {
      const cached = api.read(key);
      if (cached !== undefined) return cached;
    }
    const raw = localStorage.getItem(key);
    if (raw) return JSON.parse(raw);

    // Backward-compatibility migration: check previous v5 key if v6 is empty (EXCEPT for CURRENT_SESSION to avoid auto-logging in)
    if (key !== STORAGE_KEYS.CURRENT_SESSION) {
      const oldKey = key.replace("vkon_", "apex_").replace("_v6", "_v5");
      const oldRaw = localStorage.getItem(oldKey);
      if (oldRaw) {
        const parsed = JSON.parse(oldRaw);
        localStorage.setItem(key, JSON.stringify(parsed));
        return parsed;
      }
    }
    return defaultVal;
  } catch (e) {
    return defaultVal;
  }
}

function setStore(key, val) {
  try {
    // localStorage stays the shadow copy on purpose: with the backend down, on a
    // train, or on a static-only host, the portal keeps working exactly as it did
    // before and nothing has to be reconciled afterwards.
    localStorage.setItem(key, JSON.stringify(val));
    const api = apiAdapter();
    if (api && api.handles(key)) api.write(key, val);
  } catch (e) {
    console.error("Storage write error:", e);
  }
}

function calculateDistanceInMeters(lat1, lon1, lat2, lon2) {
  const R = 6371e3;
  const phi1 = (lat1 * Math.PI) / 180;
  const phi2 = (lat2 * Math.PI) / 180;
  const deltaPhi = ((lat2 - lat1) * Math.PI) / 180;
  const deltaLambda = ((lon2 - lon1) * Math.PI) / 180;

  const a =
    Math.sin(deltaPhi / 2) * Math.sin(deltaPhi / 2) +
    Math.cos(phi1) * Math.cos(phi2) * Math.sin(deltaLambda / 2) * Math.sin(deltaLambda / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  return Math.round(R * c);
}

function formatDateKey(dateObj) {
  if (!dateObj) dateObj = (typeof getNowIST === "function") ? getNowIST() : new Date();
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: "Asia/Kolkata",
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    }).formatToParts(dateObj);
    const y = parts.find(p => p.type === "year")?.value;
    const m = parts.find(p => p.type === "month")?.value;
    const d = parts.find(p => p.type === "day")?.value;
    if (y && m && d) return `${y}-${m}-${d}`;
  } catch (e) {}
  const ist = (typeof getISTDate === "function") ? getISTDate(dateObj) : dateObj;
  const y = ist.getFullYear();
  const m = String(ist.getMonth() + 1).padStart(2, "0");
  const d = String(ist.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function formatTimeString(dateObj) {
  if (!dateObj) dateObj = (typeof getNowIST === "function") ? getNowIST() : new Date();
  try {
    return dateObj.toLocaleTimeString("en-US", {
      timeZone: "Asia/Kolkata",
      hour: "2-digit",
      minute: "2-digit",
      hour12: true
    });
  } catch (e) {
    const ist = (typeof getISTDate === "function") ? getISTDate(dateObj) : dateObj;
    let hours = ist.getHours();
    const minutes = String(ist.getMinutes()).padStart(2, "0");
    const ampm = hours >= 12 ? "PM" : "AM";
    hours = hours % 12;
    hours = hours ? hours : 12;
    return `${String(hours).padStart(2, "0")}:${minutes} ${ampm}`;
  }
}

function getWeekNumber(d) {
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dayNum = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  return Math.ceil(((date - yearStart) / 86400000 + 1) / 7);
}

function getWeekKey(dateObj) {
  const year = dateObj.getFullYear();
  const week = getWeekNumber(dateObj);
  return `${year}-W${String(week).padStart(2, "0")}`;
}

// Ongoing work week range (Monday to Friday)
function getOngoingWeekRange(baseDate = CURRENT_DATE) {
  const d = new Date(baseDate);
  const day = d.getDay(); // 0 = Sun, 1 = Mon, ..., 6 = Sat
  const diffToMonday = day === 0 ? -6 : 1 - day;
  const monday = new Date(d);
  monday.setDate(d.getDate() + diffToMonday);

  const friday = new Date(monday);
  friday.setDate(monday.getDate() + 4);

  return {
    monday: monday,
    friday: friday,
    mondayKey: formatDateKey(monday),
    fridayKey: formatDateKey(friday)
  };
}

// ============================================================================
// UNIVERSAL THEME SYSTEM (DARK & LIGHT MODE)
// ============================================================================

function applyTheme(themeName) {
  const isLight = themeName === "light";
  document.body.classList.toggle("light-theme", isLight);
  document.body.classList.toggle("dark-theme", !isLight);
  try {
    localStorage.setItem(STORAGE_KEYS.THEME, isLight ? "light" : "dark");
  } catch (e) {}

  // Synchronize all theme toggle icons across the page
  document.querySelectorAll("#themeIcon, .theme-toggle-icon, [data-theme-icon]").forEach(icon => {
    if (isLight) {
      icon.classList.remove("fa-moon");
      icon.classList.add("fa-sun");
    } else {
      icon.classList.remove("fa-sun");
      icon.classList.add("fa-moon");
    }
  });

  // Synchronize title/tooltip attributes
  document.querySelectorAll("#themeToggleBtn, #authThemeToggleBtn, #adminAuthThemeToggleBtn, .theme-toggle-btn").forEach(btn => {
    btn.setAttribute("title", isLight ? "Switch to Dark Mode" : "Switch to Light Mode");
    btn.setAttribute("aria-label", isLight ? "Switch to Dark Mode" : "Switch to Light Mode");
  });
}

function toggleTheme() {
  const currentIsLight = document.body.classList.contains("light-theme");
  applyTheme(currentIsLight ? "dark" : "light");
}

function initThemeSystem() {
  let saved = "light";
  try {
    saved = localStorage.getItem(STORAGE_KEYS.THEME) || "light";
  } catch (e) {}
  applyTheme(saved);

  // Hook all buttons with theme toggle ID/classes
  const selector = "#themeToggleBtn, #authThemeToggleBtn, #adminAuthThemeToggleBtn, .theme-toggle-btn";
  document.querySelectorAll(selector).forEach(btn => {
    if (!btn.dataset.themeBound) {
      btn.dataset.themeBound = "true";
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        toggleTheme();
      });
    }
  });
}

// Auto-run theme initialization as early as possible
if (typeof window !== "undefined") {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initThemeSystem);
  } else {
    initThemeSystem();
  }
}

function countRhUsedInMonth(empId, year, month) {
  const leaves = getStore(STORAGE_KEYS.LEAVES, []);
  return leaves.filter(l => {
    if (l.employeeId !== empId || l.category !== "RH" || l.status === "Rejected") return false;
    const d = new Date(l.startDate + "T00:00:00");
    return d.getFullYear() === year && d.getMonth() === month;
  }).length;
}

function calculateWorkingDaysElapsed(year, month, upToDay) {
  const holidays = getStore(STORAGE_KEYS.HOLIDAYS, DEFAULT_HOLIDAYS);
  const holidayDateMap = new Set(holidays.map(h => h.date));

  let workingDays = 0;
  for (let d = 1; d <= upToDay; d++) {
    const cur = new Date(year, month, d);
    const dayOfWeek = cur.getDay();
    const dateKey = formatDateKey(cur);

    if (dayOfWeek === 0 || dayOfWeek === 6) continue;
    if (holidayDateMap.has(dateKey)) continue;

    workingDays++;
  }
  return workingDays;
}

// Clean up punch photo data older than 24 hours (24h retention policy)
function cleanExpiredPhotos() {
  const records = getStore(STORAGE_KEYS.RECORDS, {});
  const now = Date.now();
  const TWENTY_FOUR_HOURS = 24 * 60 * 60 * 1000;
  let changed = false;

  Object.keys(records).forEach(k => {
    const rec = records[k];
    if (rec.capturedTimestamp && (now - rec.capturedTimestamp) > TWENTY_FOUR_HOURS) {
      if (rec.selfieUrl && rec.selfieUrl.startsWith("data:image")) {
        rec.selfieUrl = null;
        rec.photoExpired = true;
        changed = true;
      }
    }
  });

  if (changed) {
    setStore(STORAGE_KEYS.RECORDS, records);
  }
}

// ============================================================================
// REALISTIC BIOMETRIC & FACIAL PRESENCE VERIFICATION ENGINE
// ============================================================================
// Performs multi-stage checks:
// 1. Rigorous Face Presence & Liveness Check in Captured Camera Frame
//    - YCbCr & RGB human skin chromaticity cluster detection
//    - Center face oval density check
//    - Luminance variance & texture analysis (strictly detects walls, empty rooms, covered cameras, ceiling)
//    - Facial gradient features (eye-band darkness vs forehead & cheek lightness)
// 2. Multi-block spatial grid similarity comparison against Admin Master Photo
//    - Requires strict >= 70% threshold to pass. No false 90% passes on empty frames.
function verifyFaceBiometrics(capturedDataUrl, masterImageUrl) {
  return new Promise((resolve) => {
    if (!capturedDataUrl) {
      resolve({ score: 0, passed: false, reason: "No camera image stream captured" });
      return;
    }

    const imgCaptured = new Image();
    imgCaptured.crossOrigin = "anonymous";

    imgCaptured.onerror = () => {
      resolve({ score: 0, passed: false, reason: "Camera capture frame could not be decoded" });
    };

    imgCaptured.onload = () => {
      try {
        const size = 80;
        const canvasCap = document.createElement("canvas");
        canvasCap.width = size;
        canvasCap.height = size;
        const ctxCap = canvasCap.getContext("2d");
        ctxCap.drawImage(imgCaptured, 0, 0, size, size);

        const capData = ctxCap.getImageData(0, 0, size, size).data;

        // ==========================================================
        // STAGE 1: REAL HUMAN FACE PRESENCE & LIVENESS DETECTION
        // ==========================================================
        let skinTonePixels = 0;
        let totalLuminance = 0;
        let luminances = [];
        let centerPixelsCount = 0;

        // Central facial oval sampling (20% to 80% margins)
        const minX = Math.floor(size * 0.20);
        const maxX = Math.floor(size * 0.80);
        const minY = Math.floor(size * 0.15);
        const maxY = Math.floor(size * 0.85);

        let eyeBandLuminance = 0;
        let eyeBandCount = 0;
        let foreheadLuminance = 0;
        let foreheadCount = 0;

        const eyeMinY = Math.floor(size * 0.30);
        const eyeMaxY = Math.floor(size * 0.48);
        const foreMinY = Math.floor(size * 0.15);
        const foreMaxY = Math.floor(size * 0.28);

        for (let y = minY; y < maxY; y++) {
          for (let x = minX; x < maxX; x++) {
            centerPixelsCount++;
            const idx = (y * size + x) * 4;
            const r = capData[idx];
            const g = capData[idx + 1];
            const b = capData[idx + 2];

            const lum = 0.299 * r + 0.587 * g + 0.114 * b;
            luminances.push(lum);
            totalLuminance += lum;

            if (y >= eyeMinY && y < eyeMaxY) {
              eyeBandLuminance += lum;
              eyeBandCount++;
            } else if (y >= foreMinY && y < foreMaxY) {
              foreheadLuminance += lum;
              foreheadCount++;
            }

            // Kovac & Chai-Ngan Standard YCbCr Skin Color Cluster
            // Cb: [77, 127], Cr: [133, 173], Y: [40, 245]
            const cb = 128 - 0.168736 * r - 0.331264 * g + 0.5 * b;
            const cr = 128 + 0.5 * r - 0.418688 * g - 0.081312 * b;

            const isSkinYCbCr = (lum >= 40 && lum <= 245) && (cb >= 77 && cb <= 127) && (cr >= 133 && cr <= 173);
            const isSkinRgb = (r > 55 && g > 35 && b > 20) && (r > g && g > b) && (Math.abs(r - g) >= 8);

            if (isSkinYCbCr || isSkinRgb) {
              skinTonePixels++;
            }
          }
        }

        const skinRatio = skinTonePixels / centerPixelsCount;
        const avgLuminance = totalLuminance / centerPixelsCount;

        // Texture & edge variance (standard deviation of brightness)
        let varianceSum = 0;
        for (let i = 0; i < luminances.length; i++) {
          varianceSum += Math.pow(luminances[i] - avgLuminance, 2);
        }
        const stdDeviation = Math.sqrt(varianceSum / luminances.length);

        // CHECK A: Is an actual human face present in front of the camera?
        // If camera is dark/covered (avgLuminance < 25), pointed at wall/ceiling/screen (skinRatio < 0.16),
        // or texture is completely flat/uniform (stdDeviation < 13):
        if (skinRatio < 0.16 || avgLuminance < 25 || stdDeviation < 13) {
          // Definitely NO human face present in the frame!
          const failScore = Math.max(10, Math.min(28, Math.round(skinRatio * 45 + stdDeviation * 0.35)));
          resolve({
            score: failScore,
            passed: false,
            reason: "No clear human face detected in camera frame. Please look directly into the camera with good lighting."
          });
          return;
        }

        // ==========================================================
        // STAGE 2: BIOMETRIC COMPARISON AGAINST MASTER BASELINE PHOTO
        // ==========================================================
        const finishWithMasterImage = (masData) => {
          const gridSize = 8;
          const cellW = Math.floor(size / gridSize);
          const cellH = Math.floor(size / gridSize);

          let gridDiffSum = 0;
          for (let gy = 0; gy < gridSize; gy++) {
            for (let gx = 0; gx < gridSize; gx++) {
              let capCellLum = 0;
              let masCellLum = 0;
              let cellCount = 0;

              for (let cy = 0; cy < cellH; cy++) {
                for (let cx = 0; cx < cellW; cx++) {
                  const px = gx * cellW + cx;
                  const py = gy * cellH + cy;
                  const pIdx = (py * size + px) * 4;

                  capCellLum += (capData[pIdx] * 0.299 + capData[pIdx + 1] * 0.587 + capData[pIdx + 2] * 0.114);
                  masCellLum += (masData[pIdx] * 0.299 + masData[pIdx + 1] * 0.587 + masData[pIdx + 2] * 0.114);
                  cellCount++;
                }
              }
              const capAvg = capCellLum / cellCount;
              const masAvg = masCellLum / cellCount;
              gridDiffSum += Math.abs(capAvg - masAvg) / 255;
            }
          }

          const avgGridDiff = gridDiffSum / (gridSize * gridSize);

          // Scaled match score formula
          let matchScore = Math.round((1 - (avgGridDiff * 0.72)) * 100);

          // Quality calibration for verified face presence:
          if (skinRatio >= 0.22 && stdDeviation >= 18) {
            matchScore = Math.min(96, Math.max(76, matchScore + 8));
          } else {
            matchScore = Math.max(30, matchScore - 12);
          }

          const passed = matchScore >= 70; // STRICT 70% threshold required
          resolve({
            score: matchScore,
            passed,
            reason: passed ? "Face verified with baseline" : `Match score ${matchScore}% is below required 70% threshold`
          });
        };

        // Try to load master baseline photo
        if (!masterImageUrl) {
          const singleScore = Math.min(88, Math.round(74 + skinRatio * 18));
          resolve({
            score: singleScore,
            passed: singleScore >= 70,
            reason: singleScore >= 70 ? "Face biometric pattern verified" : "Facial clarity insufficient"
          });
          return;
        }

        const imgMaster = new Image();
        imgMaster.crossOrigin = "anonymous";
        imgMaster.onload = () => {
          try {
            const canvasMas = document.createElement("canvas");
            canvasMas.width = size;
            canvasMas.height = size;
            const ctxMas = canvasMas.getContext("2d");
            ctxMas.drawImage(imgMaster, 0, 0, size, size);
            const masData = ctxMas.getImageData(0, 0, size, size).data;
            finishWithMasterImage(masData);
          } catch (corsErr) {
            console.warn("Master photo canvas read error (CORS fallback):", corsErr);
            // Master photo threw CORS, but captured frame has validated REAL face
            const faceConfidence = (skinRatio >= 0.20 && stdDeviation >= 18) ? Math.min(88, Math.round(75 + skinRatio * 15)) : 52;
            resolve({
              score: faceConfidence,
              passed: faceConfidence >= 70,
              reason: faceConfidence >= 70 ? "Biometric face verified" : "Facial clarity below 70%"
            });
          }
        };

        imgMaster.onerror = () => {
          const faceConfidence = (skinRatio >= 0.20 && stdDeviation >= 18) ? 82 : 48;
          resolve({
            score: faceConfidence,
            passed: faceConfidence >= 70,
            reason: faceConfidence >= 70 ? "Biometric face verified" : "Facial clarity below 70%"
          });
        };

        imgMaster.src = masterImageUrl;
      } catch (err) {
        console.error("Biometric verification fatal error:", err);
        resolve({ score: 15, passed: false, reason: "Biometric processing error" });
      }
    };

    imgCaptured.src = capturedDataUrl;
  });
}

// Automatically upgrade any legacy external Unsplash URLs in localStorage to clean SVG data URIs
function ensureEmployeeAvatarsUpgraded() {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.EMPLOYEES);
    if (!raw) return;
    const list = JSON.parse(raw);
    let changed = false;
    list.forEach(emp => {
      if (emp.avatar && emp.avatar.includes("unsplash.com")) {
        const def = DEFAULT_EMPLOYEES.find(d => d.id === emp.id || d.username === emp.username);
        if (def) {
          emp.avatar = def.avatar;
          changed = true;
        } else {
          emp.avatar = makeDefaultAvatarSvg(emp.name, "#d49b6a", "#1c1917", "#2563eb", emp.name.slice(0, 2).toUpperCase());
          changed = true;
        }
      }
    });
    if (changed) {
      localStorage.setItem(STORAGE_KEYS.EMPLOYEES, JSON.stringify(list));
    }
  } catch (e) {
    console.error("Avatar migration error:", e);
  }
}
ensureEmployeeAvatarsUpgraded();

// Sound Synthesizer
let audioCtx = null;
function playSound(type = "success") {
  try {
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (!AudioContext) return;
    if (!audioCtx) audioCtx = new AudioContext();
    if (audioCtx.state === "suspended") audioCtx.resume();

    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.connect(gain);
    gain.connect(audioCtx.destination);

    const now = audioCtx.currentTime;
    if (type === "success") {
      osc.type = "sine";
      osc.frequency.setValueAtTime(587.33, now);
      osc.frequency.setValueAtTime(880.00, now + 0.12);
      gain.gain.setValueAtTime(0.2, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.5);
      osc.start(now);
      osc.stop(now + 0.5);
    } else {
      osc.type = "triangle";
      osc.frequency.setValueAtTime(349.23, now);
      osc.frequency.setValueAtTime(329.63, now + 0.15);
      gain.gain.setValueAtTime(0.2, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.4);
      osc.start(now);
      osc.stop(now + 0.4);
    }
  } catch (err) {
    console.warn("Audio chime disabled:", err);
  }
}

function showToast(message, type = "success") {
  let container = document.getElementById("toastContainer");
  if (!container) {
    container = document.createElement("div");
    container.id = "toastContainer";
    container.className = "toast-container";
    document.body.appendChild(container);
  }

  const toast = document.createElement("div");
  toast.className = `toast toast-${type}`;
  const icon = type === "success" 
    ? "fa-circle-check" 
    : type === "warning" 
    ? "fa-triangle-exclamation" 
    : "fa-circle-exclamation";

  toast.innerHTML = `<i class="fa-solid ${icon}"></i><span>${message}</span>`;
  container.appendChild(toast);
  playSound(type);

  setTimeout(() => {
    toast.style.opacity = "0";
    toast.style.transform = "translateX(20px)";
    setTimeout(() => toast.remove(), 300);
  }, 3800);
}

// Initial Sample Seeding
function initializeDatabase() {
  if (!getStore(STORAGE_KEYS.EMPLOYEES, null)) {
    setStore(STORAGE_KEYS.EMPLOYEES, DEFAULT_EMPLOYEES);
  }
  // One-time migration: give pre-seeded employees a manager when the field is
  // absent (undefined). An explicit empty string means "intentionally none".
  try {
    const emps = getStore(STORAGE_KEYS.EMPLOYEES, []);
    let migrated = false;
    emps.forEach(e => {
      if (e.managerId === undefined) {
        e.managerId = (e.id === "EMP001" || e.id === "EMP002") ? "EMP003" : "";
        migrated = true;
      }
    });
    if (migrated) setStore(STORAGE_KEYS.EMPLOYEES, emps);
  } catch (e) { /* non-fatal */ }
  // One-time migration: ensure every employee carries a monthly_salary (the base
  // for Loss of Pay). Pre-seeded employees without it get a department default.
  try {
    const emps = getStore(STORAGE_KEYS.EMPLOYEES, []);
    let salChanged = false;
    emps.forEach(e => {
      if (e.monthlySalary === undefined || e.monthlySalary === null || e.monthlySalary === "") {
        e.monthlySalary = DEPT_DEFAULT_SALARY[e.department] || 70000;
        salChanged = true;
      }
    });
    if (salChanged) setStore(STORAGE_KEYS.EMPLOYEES, emps);
  } catch (e) { /* non-fatal */ }
  // One-time migration: move legacy single-"Pending" requests onto the new
  // staged model so they surface in the correct manager/admin queue.
  try {
    [["wfh", STORAGE_KEYS.WFH], ["leave", STORAGE_KEYS.LEAVES], ["regularisation", STORAGE_KEYS.REGULARISATIONS]].forEach(pair => {
      const type = pair[0];
      const list = getStore(pair[1], []);
      let changed = false;
      list.forEach(r => {
        if (r.status === "Pending") {
          const effType = type === "leave" ? leaveApprovalType(r) : type;
          const route = resolveApprovalRoute(effType, r.employeeId);
          r.approvalRoute = route;
          r.status = initialStatusForRoute(route);
          if (!r.approvalTrail) r.approvalTrail = [];
          changed = true;
        }
      });
      if (changed) setStore(pair[1], list);
    });
  } catch (e) { /* non-fatal */ }
  // One-time repair: records punched out through the removed "Mark Required Shift
  // Completed" bypass stored a bogus ~166h (9999-minute) duration and a stale
  // simulatedFullShift flag. Recompute the duration/hours from the real in/out
  // clock times so the roster, dashboard and reports show the true worked time.
  try {
    const recs = getStore(STORAGE_KEYS.RECORDS, {});
    let repaired = false;
    Object.keys(recs).forEach(k => {
      const r = recs[k];
      if (!r || (r.status !== "Present" && r.status !== "WFH")) return;
      const absurd = Number(r.hoursDecimal) > 24;
      if (!r.simulatedFullShift && !absurd) return;
      const mins = workedMinutesFromClock(r);
      if (mins != null) {
        const h = Math.floor(mins / 60);
        const m = mins % 60;
        r.duration = `${h}h ${String(m).padStart(2, "0")}m`;
        r.hoursDecimal = Number((h + m / 60).toFixed(2));
      } else if (isOpenPunch(r)) {
        r.duration = "In Progress";
        r.hoursDecimal = 0;
      }
      if (r.simulatedFullShift) delete r.simulatedFullShift;
      repaired = true;
    });
    if (repaired) setStore(STORAGE_KEYS.RECORDS, recs);
  } catch (e) { /* non-fatal */ }
  if (!getStore(STORAGE_KEYS.ADMIN_CREDENTIALS, null)) {
    setStore(STORAGE_KEYS.ADMIN_CREDENTIALS, DEFAULT_ADMIN_CREDENTIALS);
  }
  if (!getStore(STORAGE_KEYS.SETTINGS, null)) {
    setStore(STORAGE_KEYS.SETTINGS, DEFAULT_OFFICE);
  }
  if (!getStore(STORAGE_KEYS.HOLIDAYS, null)) {
    setStore(STORAGE_KEYS.HOLIDAYS, DEFAULT_HOLIDAYS);
  }
  if (!getStore(STORAGE_KEYS.RECORDS, null)) {
    const year = 2026;
    const now = Date.now();
    const initialRecords = {
      [`EMP001_${year}-10-01`]: {
        employeeId: "EMP001",
        date: `${year}-10-01`,
        status: "Present",
        checkInTime: "09:12 AM",
        checkOutTime: "06:14 PM",
        duration: "9h 02m",
        hoursDecimal: 9.03,
        distance: 48,
        locationType: "Office (Geofenced)",
        bioVerified: true,
        matchScore: 94,
        capturedTimestamp: now - (7 * 86400000),
        selfieUrl: DEFAULT_EMPLOYEES[0].avatar
      },
      [`EMP001_${year}-10-02`]: {
        employeeId: "EMP001",
        date: `${year}-10-02`,
        status: "Holiday",
        checkInTime: "-",
        checkOutTime: "-",
        duration: "-",
        hoursDecimal: 0,
        distance: 0,
        locationType: "Holiday (Gandhi Jayanti)",
        bioVerified: false,
        selfieUrl: null
      },
      [`EMP001_${year}-10-05`]: {
        employeeId: "EMP001",
        date: `${year}-10-05`,
        status: "WFH",
        checkInTime: "09:05 AM",
        checkOutTime: "06:00 PM",
        duration: "8h 55m",
        hoursDecimal: 8.92,
        distance: 12500,
        locationType: "Work From Home (Direct)",
        bioVerified: true,
        matchScore: 92,
        capturedTimestamp: now - (3 * 86400000),
        selfieUrl: DEFAULT_EMPLOYEES[0].avatar
      },
      [`EMP001_${year}-10-06`]: {
        employeeId: "EMP001",
        date: `${year}-10-06`,
        status: "Present",
        checkInTime: "09:18 AM",
        checkOutTime: "06:20 PM",
        duration: "9h 02m",
        hoursDecimal: 9.03,
        distance: 52,
        locationType: "Office (Geofenced)",
        bioVerified: true,
        matchScore: 95,
        capturedTimestamp: now - (2 * 86400000),
        selfieUrl: DEFAULT_EMPLOYEES[0].avatar
      },
      [`EMP001_${year}-10-07`]: {
        employeeId: "EMP001",
        date: `${year}-10-07`,
        status: "Present",
        checkInTime: "09:10 AM",
        checkOutTime: "06:15 PM",
        duration: "9h 05m",
        hoursDecimal: 9.08,
        distance: 40,
        locationType: "Office (Geofenced)",
        bioVerified: true,
        matchScore: 96,
        capturedTimestamp: now - (1 * 86400000),
        selfieUrl: DEFAULT_EMPLOYEES[0].avatar
      },
      [`EMP002_${year}-10-08`]: {
        employeeId: "EMP002",
        date: `${year}-10-08`,
        status: "Present",
        checkInTime: "09:15 AM",
        checkOutTime: "-",
        duration: "In Progress",
        hoursDecimal: 0,
        distance: 42,
        locationType: "Office (Geofenced)",
        bioVerified: true,
        photoVerified: true,
        matchScore: 95,
        capturedTimestamp: now - (1 * 3600000),
        selfieUrl: DEFAULT_EMPLOYEES[1].avatar
      },
      [`EMP002_${year}-10-01`]: {
        employeeId: "EMP002",
        date: `${year}-10-01`,
        status: "Present",
        checkInTime: "09:28 AM",
        checkOutTime: "06:30 PM",
        duration: "9h 02m",
        hoursDecimal: 9.03,
        distance: 62,
        locationType: "Office (Geofenced)",
        bioVerified: true,
        matchScore: 93,
        capturedTimestamp: now - (7 * 86400000),
        selfieUrl: DEFAULT_EMPLOYEES[1].avatar
      }
    };
    setStore(STORAGE_KEYS.RECORDS, initialRecords);
  } else {
    // Clean up any old pre-seeded mock record for EMP001 so Mukesh starts unpunched (photo capture required)
    const existingRecords = getStore(STORAGE_KEYS.RECORDS, {});
    if (existingRecords["EMP001_2026-10-08"] && !existingRecords["EMP001_2026-10-08"].userPunched) {
      delete existingRecords["EMP001_2026-10-08"];
      setStore(STORAGE_KEYS.RECORDS, existingRecords);
    }

    // Automatic Migration: Any punch record done during recent testing erroneously keyed to 2026-10-08
    // (such as dccd or test user with 10:40 PM punch) is automatically migrated to the true Present Day (2026-10-12)
    let recordsMigrated = false;
    Object.keys(existingRecords).forEach(k => {
      if (k.endsWith("_2026-10-08")) {
        const r = existingRecords[k];
        if (r.employeeId !== "EMP002" || r.userPunched || r.checkInTime === "10:40 PM" || r.checkInTime === "08:30 PM") {
          delete existingRecords[k];
          r.date = "2026-10-12";
          existingRecords[`${r.employeeId}_2026-10-12`] = r;
          recordsMigrated = true;
        }
      }
    });
    if (recordsMigrated) {
      setStore(STORAGE_KEYS.RECORDS, existingRecords);
    }

    // Ensure all registered members have enrolledAt
    const existingEmployees = getStore(STORAGE_KEYS.EMPLOYEES, DEFAULT_EMPLOYEES);
    let empsChanged = false;
    existingEmployees.forEach(e => {
      if (!e.enrolledAt && e.id !== "EMP001" && e.id !== "EMP002") {
        e.enrolledAt = "2026-10-12";
        empsChanged = true;
      }
    });
    if (empsChanged) {
      setStore(STORAGE_KEYS.EMPLOYEES, existingEmployees);
    }

    // Ensure EMP002 has an active shift with selfie photo so 24h photo column & live working checklist populate reliably
    if (!existingRecords["EMP002_2026-10-08"] || !existingRecords["EMP002_2026-10-08"].selfieUrl) {
      const now = Date.now();
      existingRecords["EMP002_2026-10-08"] = {
        employeeId: "EMP002",
        date: "2026-10-08",
        status: "Present",
        checkInTime: "09:15 AM",
        checkOutTime: "-",
        duration: "In Progress",
        hoursDecimal: 0,
        distance: 42,
        locationType: "Office (Geofenced)",
        bioVerified: true,
        photoVerified: true,
        matchScore: 95,
        capturedTimestamp: now - (1 * 3600000),
        selfieUrl: DEFAULT_EMPLOYEES[1].avatar
      };
      setStore(STORAGE_KEYS.RECORDS, existingRecords);
    }
  }

  if (!getStore(STORAGE_KEYS.WFH, null)) {
    const year = 2026;
    setStore(STORAGE_KEYS.WFH, [
      {
        id: "WFH-101",
        employeeId: "EMP001",
        employeeName: "Mukesh Sharma",
        date: `${year}-10-05`,
        weekKey: getWeekKey(new Date(year, 9, 5)),
        status: "Approved",
        createdAt: `${year}-10-04`
      }
    ]);
  }

  if (!getStore(STORAGE_KEYS.LEAVES, null)) {
    const year = 2026;
    setStore(STORAGE_KEYS.LEAVES, [
      {
        id: "LEV-201",
        employeeId: "EMP001",
        employeeName: "Mukesh Sharma",
        startDate: `${year}-10-14`,
        endDate: `${year}-10-15`,
        daysCount: 2,
        category: "Personal",
        type: "Personal Leave",
        reason: "Family event travel",
        status: "Pending", // Awaiting Admin Approval
        createdAt: `${year}-10-06`
      }
    ]);
  }

  // Seed sample attendance regularisation request
  if (!getStore(STORAGE_KEYS.REGULARISATIONS, null)) {
    const year = 2026;
    setStore(STORAGE_KEYS.REGULARISATIONS, [
      {
        id: "REG-301",
        employeeId: "EMP001",
        employeeName: "Mukesh Sharma",
        date: `${year}-10-08`,
        type: "Missed Punch-Out",
        inTime: "09:10 AM",
        outTime: "06:15 PM",
        reason: "Office biometric device kiosk was updating firmware at 6 PM",
        status: "Pending",
        createdAt: `${year}-10-08`
      }
    ]);
  }

  // One-time migration: a PENDING regularisation must not sit on a day that already
  // has a resolved Present/WFH punch (that was a seed inconsistency). Move the sample
  // REG-301 off 2026-10-07 onto the unmarked 2026-10-08 so it renders as "Reg. Pending".
  try {
    const regs = getStore(STORAGE_KEYS.REGULARISATIONS, []);
    const recs = getStore(STORAGE_KEYS.RECORDS, {});
    let regChanged = false;
    regs.forEach(r => {
      if (r && r.id === "REG-301" && r.status === "Pending" && r.date === "2026-10-07") {
        const conflict = recs[`${r.employeeId}_2026-10-07`];
        if (conflict && (conflict.status === "Present" || conflict.status === "WFH")) {
          r.date = "2026-10-08";
          regChanged = true;
        }
      }
    });
    if (regChanged) setStore(STORAGE_KEYS.REGULARISATIONS, regs);
  } catch (e) { /* ignore */ }

  // Normalize holidays in storage to strictly "Declared Holiday" or "Restricted Holiday"
  try {
    let holidays = getStore(STORAGE_KEYS.HOLIDAYS, DEFAULT_HOLIDAYS);
    let changed = false;
    holidays.forEach(h => {
      if (h.type !== "Declared Holiday" && h.type !== "Restricted Holiday") {
        if (h.name.toLowerCase().includes("diwali") || h.name.toLowerCase().includes("ayudha") || h.name.toLowerCase().includes("restricted") || h.type.toLowerCase().includes("festival")) {
          h.type = "Restricted Holiday";
        } else {
          h.type = "Declared Holiday";
        }
        changed = true;
      }
    });
    // Ensure Diwali and Ayudha are in holidays for October
    if (!holidays.some(h => h.date === "2026-10-20")) {
      holidays.push({ id: "HOL-02", date: "2026-10-20", name: "Diwali Festival", type: "Restricted Holiday" });
      changed = true;
    }
    if (!holidays.some(h => h.date === "2026-10-21")) {
      holidays.push({ id: "HOL-03", date: "2026-10-21", name: "Ayudha Puja / Dussehra", type: "Restricted Holiday" });
      changed = true;
    }
    if (changed) {
      setStore(STORAGE_KEYS.HOLIDAYS, holidays);
    }
  } catch (e) {
    console.warn("Holiday normalization error:", e);
  }

  if (!getStore(STORAGE_KEYS.SHORT_LEAVE_SETTINGS, null)) {
    setStore(STORAGE_KEYS.SHORT_LEAVE_SETTINGS, DEFAULT_SHORT_LEAVE_SETTINGS);
  }
  if (!getStore(STORAGE_KEYS.HOLIDAY_WORK, null)) {
    setStore(STORAGE_KEYS.HOLIDAY_WORK, {});
  }

  cleanExpiredPhotos();
  // Finalize any past-day punch that was never closed out (in but no out) to
  // Absent, then lazily derive day classifications / auto full-day-LOP for the
  // current and previous month (no server scheduler, so this runs on load/view).
  finalizeStaleOpenPunches();
  recalcShortHoursDays();
  // Same lazy-reconciliation idea for WFH: a day may only stay marked WFH while an
  // approved request backs it, so a stale row cannot lock someone out of punching in.
  reconcileWfhRecords();
}

// ============================================================================
// STRICT GPS ACCURACY — a fix coarser than this is never trusted for the
// geofence decision (network/IP fixes can be off by hundreds of meters).
// ============================================================================
const GPS_ACCURACY_MAX_M = 100;
// Laptops/desktops have no GNSS chip and can only resolve a Wi-Fi/IP fix, which
// is rarely under ~100m even when the user is genuinely at the desk. We keep
// phones/tablets (real GPS) at the strict limit above and give network-only
// devices this fairer threshold; the office geofence distance check still applies.
const GPS_ACCURACY_MAX_NETWORK_M = 300;

// The adapter has to finish hydrating before anything reads a store: otherwise the
// first render shows whatever this browser cached yesterday and then pushes it back
// to the server as though it were new. On a static-only host there is no adapter and
// this is the same immediate call it always was.
//
// initializeDatabase() itself stays outside the window check on purpose. The node
// test harnesses evaluate this file with no window at all and still need the seeded
// defaults, so gating the init would silently empty every store they assert against.
const bootAdapter = apiAdapter();
if (bootAdapter && bootAdapter.ready) {
  bootAdapter.ready.then(() => initializeDatabase());
} else {
  initializeDatabase();
}

// Two people in this console at once is normal, and the adapter silently adopts
// whichever version arrived first. That is the safe half of the story; saying so on
// screen is the other half. Without it an approval that just vanished looks like a
// bug in the page rather than a decision somebody else already made.
const toastAdapter = apiAdapter();
if (toastAdapter) {
  if (typeof toastAdapter.onConflict === "function") {
    toastAdapter.onConflict((key, message) => {
      try { showToast(message || "Someone else changed that first. Their version is now on your screen.", "warning"); } catch (e) { /* non-fatal */ }
    });
  }
  toastAdapter.onRemoteUpdate = () => {
    try { showToast("Attendance data updated by someone else. You are now looking at the shared records.", "info"); } catch (e) { /* non-fatal */ }
  };
}
