/**
 * lib/rules/ist.ts -- the clock and calendar primitives every other rule is built on.
 *
 * Ported verbatim from public/shared.js. India is a single fixed offset with no DST, so
 * the "day" an attendance record belongs to is an IST calendar date, and the only honest
 * way to compute it is to convert an instant to Asia/Kolkata and read its parts -- never
 * to trust the server's own local time zone, which on the deploy host may be UTC.
 *
 * getISTDate is subtle and deliberately kept: it converts by rendering the instant as an
 * IST wall-clock string and re-parsing it, so the resulting Date's LOCAL getters read the
 * IST wall clock. That quirk is relied on downstream (payroll cut-offs compare against a
 * locally-constructed Date), so it is reproduced exactly rather than "cleaned up". A
 * cleanup here would change which side of midnight a punch falls on -- a real behaviour
 * change dressed as a refactor.
 */

/** A record, as far as the clock helpers need it. */
export interface PunchLike {
  checkInTime?: string | null;
  checkOutTime?: string | null;
  status?: string;
  hoursDecimal?: number;
  [k: string]: unknown;
}

/** The IST wall clock, as a Date whose local getters read Indian civil time. */
export function getISTDate(date: Date): Date {
  try {
    const istString = date.toLocaleString("en-US", { timeZone: "Asia/Kolkata" });
    return new Date(istString);
  } catch {
    const utcMs = date.getTime() + date.getTimezoneOffset() * 60000;
    return new Date(utcMs + 5.5 * 3600000);
  }
}

/** The Asia/Kolkata calendar key (YYYY-MM-DD) for an instant. */
export function istDateKey(date: Date): string {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: "Asia/Kolkata",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(date);
    const y = parts.find((p) => p.type === "year")?.value;
    const m = parts.find((p) => p.type === "month")?.value;
    const d = parts.find((p) => p.type === "day")?.value;
    if (y && m && d) return `${y}-${m}-${d}`;
  } catch {
    /* fall through to the local-IST interpretation below */
  }
  const ist = getISTDate(date);
  const y = ist.getFullYear();
  const m = String(ist.getMonth() + 1).padStart(2, "0");
  const d = String(ist.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** "h:mm AM/PM" -> minutes since midnight, or null. */
export function parseClockToMinutes(str?: string | null): number | null {
  const m = /^(\d{1,2}):(\d{2})\s*(AM|PM)$/i.exec((str || "").trim());
  if (!m) return null;
  let h = parseInt(m[1] as string, 10) % 12;
  if (/pm/i.test(m[3] as string)) h += 12;
  const mm = parseInt(m[2] as string, 10);
  if (h > 23 || mm > 59) return null;
  return h * 60 + mm;
}

/** Worked minutes from the actual clock strings; null if unparseable or negative. */
export function workedMinutesFromClock(rec?: PunchLike | null): number | null {
  if (!rec) return null;
  const inM = parseClockToMinutes(rec.checkInTime);
  const outM = parseClockToMinutes(rec.checkOutTime);
  if (inM == null || outM == null) return null;
  return outM >= inM ? outM - inM : null;
}

/** A check-in with no check-out yet -- still open. */
export function isOpenPunch(rec?: PunchLike | null): boolean {
  if (!rec) return false;
  const noOut = !rec.checkOutTime || rec.checkOutTime === "-";
  return noOut && (rec.status === "Present" || rec.status === "WFH");
}

/** Worked hours (decimal): prefer the clock, fall back to the stored hoursDecimal. */
export function computeWorkedHours(rec?: PunchLike | null): number {
  if (!rec) return 0;
  const mins = workedMinutesFromClock(rec);
  if (mins != null) return Number((mins / 60).toFixed(2));
  return Number(rec.hoursDecimal) || 0;
}

/** Whole days from `fromKey` to `toKey`, UTC-anchored so the count is DST-proof. */
export function diffDaysUTC(fromKey: string, toKey: string): number {
  const a = Date.parse(fromKey + "T00:00:00Z");
  const b = Date.parse(toKey + "T00:00:00Z");
  if (isNaN(a) || isNaN(b)) return 0;
  return Math.round((b - a) / 86400000);
}

/** "Oct 12" for an alert sentence. */
export function prettyDateKey(key: string): string {
  const d = new Date(key + "T00:00:00Z");
  if (isNaN(d.getTime())) return key;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

/** ISO-8601 week number, matching the browser's getWeekNumber. */
export function weekNumber(d: Date): number {
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dayNum = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  return Math.ceil(((date.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
}

/** Format a minute span as "Xh YYm" (always positive; caller adds the sign/word). */
export function formatMinutesHM(mins: number): string {
  const a = Math.abs(Math.round(mins));
  return `${Math.floor(a / 60)}h ${String(a % 60).padStart(2, "0")}m`;
}

/** `${year}-W${ww}` for a date, matching getWeekKey. */
export function weekKey(d: Date): string {
  const year = d.getFullYear();
  const week = weekNumber(d);
  return `${year}-W${String(week).padStart(2, "0")}`;
}

/**
 * The payroll-close calendar date for the month CONTAINING dateStr. Payroll closes on
 * `cutOffDay` of the FOLLOWING month, so a January day's deadline is early February.
 */
export function payrollCutOffKeyFor(dateStr: string, cutOffDay: number): string | null {
  const parts = String(dateStr).split("-");
  const y = Number(parts[0]);
  const m = Number(parts[1]); // 1..12
  if (!y || !m) return null;
  const day = Math.max(1, Math.min(28, Number(cutOffDay) || 1));
  const d = new Date(y, m, day); // month index m is the next month in 0-based terms
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/**
 * Has the month that contains dateStr closed for editing? The cut-off is built as a local
 * Date at 23:59:59 and compared against the IST wall clock -- both "civil time", so the
 * comparison means "is it already after the last minute of the cut-off day", whichever
 * zone the host runs in.
 */
export function isPastPayrollCutOff(dateStr: string, cutOffDay: number, now: Date): boolean {
  const parts = String(dateStr).split("-");
  const y = Number(parts[0]);
  const m = Number(parts[1]);
  if (!y || !m) return false;
  const cut = new Date(y, m, Math.max(1, Math.min(28, Number(cutOffDay) || 1)), 23, 59, 59);
  return getISTDate(now).getTime() > cut.getTime();
}
