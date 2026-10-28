/**
 * lib/punches.ts -- recording a punch, and reading it back, as the server decides it.
 *
 * Three properties the plan (M6) makes non-negotiable, and where each lives here:
 *
 *   1. IDEMPOTENT on the queue's key. The browser records the punch locally, queues it,
 *      and replays the queue whenever a connection appears (js/api.js drains on every
 *      flush and on every `online` event). A replayed check-in or check-out must not
 *      book the arrival twice. Each half of the shift carries its own key
 *      (`records.punch_id` / `records.check_out_punch_id`); the lookup happens before any
 *      write, and the unique index is the backstop if two flushes race.
 *   2. SERVER-SIDE geofence. The coordinates and the accuracy figure are stored as the
 *      device reported them -- measurements are trusted -- but whether that places the
 *      person at the office is drawn HERE from the current `settings`, never accepted from
 *      the client. The verdict is recomputed on read too, so moving the fence re-decides
 *      history rather than only tomorrow's punches.
 *   3. ROLLOVER. A tab left open past midnight must yield "yesterday's close and today's
 *      open": when a check-in arrives for a new day, any still-open earlier day is closed
 *      at the boundary that begins today. That is a genuine time rule (a shift that ran
 *      over), not an absent day, so it is not marked the way a forgotten punch-out is.
 *
 * The attendance day is derived by the server from the punch instant -- the clamped
 * client capture time, so an offline punch booked at the gate is credited to the day it
 * happened on, not the day the queue finally drained. A client clock running ahead is
 * clamped to the server clock rather than trusted (see `clampInstant`).
 */

import type { PoolClient } from "pg";
import { withTransaction, query, PG, pgCode } from "./db/pool";
import { geofenceVerdict, type GeofenceVerdict } from "./rules/geofence";
import { formatISTClock, istDateKey } from "./rules/ist";
import { geofenceContext, readSettingsMap } from "./state/settings";
import { badRequest, forbidden } from "./http/errors";

/** A punch as the offline queue sends it (js/api.js `punch()`), after validation. */
export interface PunchCommand {
  punchId: string;
  kind: "in" | "out";
  /** The portal's employee code ("EMP001"), already authorisation-checked by the route. */
  employeeCode: string;
  clientCapturedAt: string | null;
  latitude: number | null;
  longitude: number | null;
  accuracyM: number | null;
}

/** The response body js/api.js and the day table read: `_punch_out` in the old backend. */
export interface PunchResult {
  punchId: string;
  employeeId: string;
  kind: string;
  istDate: string;
  serverTime: string;
  insideGeofence: boolean;
  distanceM: number | null;
  note: string | null;
  duplicate: boolean;
  /** The day (YYYY-MM-DD) a rollover just closed, when this punch closed an earlier one. */
  closedPriorDay: string | null;
}

interface RecordRow {
  id: string;
  attendance_day: string | Date;
  check_in_at: Date | null;
  check_out_at: Date | null;
  check_in_lat: number | null;
  check_in_lng: number | null;
  check_in_accuracy_m: string | number | null;
  check_out_lat: number | null;
  check_out_lng: number | null;
  check_out_accuracy_m: string | number | null;
}

/**
 * A `date` column comes back from node-pg as a JavaScript Date at local midnight; the API
 * speaks the ISO calendar key. Reading it through the local getters is correct precisely
 * because node-pg anchors a bare date to local midnight, and the container runs UTC.
 */
function toDayKey(v: string | Date): string {
  if (v instanceof Date) {
    const y = v.getFullYear();
    const m = String(v.getMonth() + 1).padStart(2, "0");
    const d = String(v.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }
  return String(v).slice(0, 10);
}

/** A client capture time, trusted only as far as it cannot book the future. */
function clampInstant(raw: string | null, received: Date): Date {
  if (!raw) return received;
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return received;
  // Ten minutes of slack absorbs a phone clock a little fast; beyond that the server
  // clock wins, so nobody books attendance in a tomorrow that has not happened.
  if (parsed.getTime() > received.getTime() + 10 * 60_000) return received;
  return parsed;
}

/** The instant that begins `dayKey` in IST -- the boundary an overnight shift closes at. */
function istMidnightStarting(dayKey: string): Date {
  return new Date(`${dayKey}T00:00:00+05:30`);
}

function numOrNull(v: string | number | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** The fence verdict for one half of a shift, from stored coordinates + settings. */
function verdictFor(
  lat: number | null,
  lng: number | null,
  accuracyM: number | null,
  ctx: ReturnType<typeof geofenceContext>,
  geofenceEnabled: boolean,
): GeofenceVerdict {
  // An employee with the fence switched off (a field role, a driver) is not refused by a
  // fix they were never required to have: the coordinates are still stored as evidence.
  if (!geofenceEnabled) {
    const distance = lat != null && lng != null
      ? geofenceVerdict(lat, lng, accuracyM, ctx.office, ctx.maxTrustedAccuracyM).distance
      : null;
    return { distance, inside: true, note: null };
  }
  return geofenceVerdict(lat, lng, accuracyM, ctx.office, ctx.maxTrustedAccuracyM);
}

/** Close any still-open day strictly earlier than `todayKey`, returning the last one closed. */
async function rolloverOpenDays(
  client: PoolClient,
  employeeId: string,
  todayKey: string,
  boundary: Date,
): Promise<string | null> {
  const closed = await client.query<{ attendance_day: string | Date }>(
    `UPDATE records
        SET check_out_at = $3
      WHERE employee_id = $1
        AND check_in_at IS NOT NULL
        AND check_out_at IS NULL
        AND attendance_day < $2::date
      RETURNING attendance_day`,
    [employeeId, todayKey, boundary],
  );
  if (!closed.rows.length) return null;
  // Newest closed day first is the most relevant one to report.
  return closed.rows.map((r) => toDayKey(r.attendance_day)).sort().at(-1) ?? null;
}

/**
 * Record one punch. Runs the whole decision -- lookup, rollover, write -- inside a single
 * transaction, so a check-in and the rollover close of yesterday commit together or not at
 * all. Returns `duplicate: true` (and writes nothing) when the queue's key is already known.
 */
export async function recordPunch(cmd: PunchCommand): Promise<PunchResult> {
  const settings = await readSettingsMap();
  const ctx = geofenceContext(settings);
  const received = new Date();
  const punchInstant = clampInstant(cmd.clientCapturedAt, received);
  const dayKey = istDateKey(punchInstant);

  return withTransaction(async (client) => {
    const empRes = await client.query<{ id: string; geofence_enabled: boolean; active: boolean }>(
      `SELECT id, geofence_enabled, active FROM employees WHERE employee_code = $1`,
      [cmd.employeeCode],
    );
    const emp = empRes.rows[0];
    if (!emp || !emp.active) {
      throw forbidden("No active employee record matches that identifier.");
    }

    if (cmd.kind === "in") {
      return recordCheckIn(client, cmd, emp, ctx, punchInstant, dayKey, received);
    }
    return recordCheckOut(client, cmd, emp, ctx, punchInstant, dayKey, received);
  });
}

async function recordCheckIn(
  client: PoolClient,
  cmd: PunchCommand,
  emp: { id: string; geofence_enabled: boolean },
  ctx: ReturnType<typeof geofenceContext>,
  punchInstant: Date,
  dayKey: string,
  received: Date,
): Promise<PunchResult> {
  // Idempotency: this exact check-in is already on file.
  const byKey = await client.query<RecordRow>(
    `SELECT * FROM records WHERE punch_id = $1`,
    [cmd.punchId],
  );
  if (byKey.rows[0]) {
    return shape(byKey.rows[0], "in", emp.geofence_enabled, cmd.employeeCode, ctx, received, true, null, cmd.punchId);
  }

  // Rollover first: opening today closes yesterday if yesterday was never closed.
  const closedPriorDay = await rolloverOpenDays(client, emp.id, dayKey, istMidnightStarting(dayKey));

  const today = await client.query<RecordRow>(
    `SELECT * FROM records WHERE employee_id = $1 AND attendance_day = $2::date`,
    [emp.id, dayKey],
  );

  if (today.rows[0]) {
    const row = today.rows[0];
    if (row.check_in_at) {
      // The day already has a check-in under a different key (an admin re-punch, or a
      // uuid-keyed queue entry that lost its deterministic id). Keep the first arrival --
      // an earlier check-in is the honest one -- and report no second booking.
      return shape(row, "in", emp.geofence_enabled, cmd.employeeCode, ctx, received, true, closedPriorDay, cmd.punchId);
    }
    const updated = await client.query<RecordRow>(
      `UPDATE records
          SET check_in_at = $3, check_in_lat = $4, check_in_lng = $5, check_in_accuracy_m = $6,
              punch_id = $7, source = 'punch'
        WHERE id = $1
        RETURNING *`,
      [row.id, emp.id, punchInstant, cmd.latitude, cmd.longitude, cmd.accuracyM, cmd.punchId],
    );
    return shape(updated.rows[0], "in", emp.geofence_enabled, cmd.employeeCode, ctx, received, false, closedPriorDay, cmd.punchId);
  }

  try {
    const inserted = await client.query<RecordRow>(
      `INSERT INTO records
         (employee_id, attendance_day, check_in_at, check_in_lat, check_in_lng, check_in_accuracy_m, punch_id, source)
       VALUES ($1, $2::date, $3, $4, $5, $6, $7, 'punch')
       RETURNING *`,
      [emp.id, dayKey, punchInstant, cmd.latitude, cmd.longitude, cmd.accuracyM, cmd.punchId],
    );
    return shape(inserted.rows[0], "in", emp.geofence_enabled, cmd.employeeCode, ctx, received, false, closedPriorDay, cmd.punchId);
  } catch (err) {
    // The unique punch_id index is the backstop for two flushes that raced past the lookup.
    if (pgCode(err) === PG.uniqueViolation) {
      const again = await client.query<RecordRow>(`SELECT * FROM records WHERE punch_id = $1`, [cmd.punchId]);
      if (again.rows[0]) return shape(again.rows[0], "in", emp.geofence_enabled, cmd.employeeCode, ctx, received, false, closedPriorDay, cmd.punchId);
    }
    throw err;
  }
}

async function recordCheckOut(
  client: PoolClient,
  cmd: PunchCommand,
  emp: { id: string; geofence_enabled: boolean },
  ctx: ReturnType<typeof geofenceContext>,
  punchInstant: Date,
  dayKey: string,
  received: Date,
): Promise<PunchResult> {
  const byKey = await client.query<RecordRow>(
    `SELECT * FROM records WHERE check_out_punch_id = $1`,
    [cmd.punchId],
  );
  if (byKey.rows[0]) {
    return shape(byKey.rows[0], "out", emp.geofence_enabled, cmd.employeeCode, ctx, received, true, null, cmd.punchId);
  }

  // The shift being closed is the most recent one still open -- which may be an earlier
  // day if the tab ran past midnight; that overnight close is exactly the rollover case.
  const open = await client.query<RecordRow>(
    `SELECT * FROM records
      WHERE employee_id = $1 AND check_in_at IS NOT NULL AND check_out_at IS NULL
      ORDER BY attendance_day DESC, check_in_at DESC
      LIMIT 1`,
    [emp.id],
  );
  if (!open.rows[0]) {
    throw badRequest("There is no open check-in to close for this employee.", "no_open_shift");
  }

  try {
    const updated = await client.query<RecordRow>(
      `UPDATE records
          SET check_out_at = $2, check_out_lat = $3, check_out_lng = $4,
              check_out_accuracy_m = $5, check_out_punch_id = $6
        WHERE id = $1
        RETURNING *`,
      [open.rows[0].id, punchInstant, cmd.latitude, cmd.longitude, cmd.accuracyM, cmd.punchId],
    );
    return shape(updated.rows[0], "out", emp.geofence_enabled, cmd.employeeCode, ctx, received, false, null, cmd.punchId);
  } catch (err) {
    if (pgCode(err) === PG.uniqueViolation) {
      const again = await client.query<RecordRow>(`SELECT * FROM records WHERE check_out_punch_id = $1`, [cmd.punchId]);
      if (again.rows[0]) return shape(again.rows[0], "out", emp.geofence_enabled, cmd.employeeCode, ctx, received, false, null, cmd.punchId);
    }
    throw err;
  }
}

/**
 * Build the response from a row. The verdict is drawn from the coordinates of the half this
 * punch is about (check-in coords for an "in", check-out coords for an "out"), so the note
 * shown for a check-out describes where the person actually was when they left.
 */
function shape(
  row: RecordRow,
  kind: "in" | "out",
  geofenceEnabled: boolean,
  employeeCode: string,
  ctx: ReturnType<typeof geofenceContext>,
  serverNow: Date,
  duplicate: boolean,
  closedPriorDay: string | null,
  punchId: string,
): PunchResult {
  const lat = kind === "in" ? row.check_in_lat : row.check_out_lat;
  const lng = kind === "in" ? row.check_in_lng : row.check_out_lng;
  const acc = numOrNull(kind === "in" ? row.check_in_accuracy_m : row.check_out_accuracy_m);
  const v = verdictFor(lat, lng, acc, ctx, geofenceEnabled);
  return {
    punchId,
    // The portal's employee code, never the uuid -- `shape` is only ever reached from a
    // path that already resolved the code (the command's target, or the list's join).
    employeeId: employeeCode,
    kind,
    istDate: toDayKey(row.attendance_day),
    serverTime: formatISTClock(serverNow),
    insideGeofence: v.inside,
    distanceM: v.distance,
    note: v.note,
    duplicate,
    closedPriorDay,
  };
}

export interface ListFilter {
  employeeCode?: string | null;
  date?: string | null;
  /** null means "every employee" (admin only). */
  restrictToCode: string | null;
  limit?: number;
}

/**
 * Read punches back. Coordinates are stored, the verdict is recomputed here from CURRENT
 * settings, so this is the same computation the projection in m6d will use and a fence move
 * re-decides history, not only new punches.
 */
export async function listPunches(filter: ListFilter): Promise<PunchResult[]> {
  const settings = await readSettingsMap();
  const ctx = geofenceContext(settings);
  const limit = Math.min(Math.max(filter.limit ?? 500, 1), 2000);

  const params: unknown[] = [];
  const where: string[] = [];
  if (filter.restrictToCode) {
    params.push(filter.restrictToCode);
    where.push(`e.employee_code = $${params.length}`);
  }
  if (filter.employeeCode) {
    params.push(filter.employeeCode);
    where.push(`e.employee_code = $${params.length}`);
  }
  if (filter.date) {
    params.push(filter.date);
    where.push(`r.attendance_day = $${params.length}::date`);
  }
  params.push(limit);

  const rows = await query<{
    id: string; attendance_day: string | Date;
    check_in_at: Date | null; check_out_at: Date | null;
    check_in_lat: number | null; check_in_lng: number | null; check_in_accuracy_m: string | number | null;
    check_out_lat: number | null; check_out_lng: number | null; check_out_accuracy_m: string | number | null;
    employee_code: string; geofence_enabled: boolean; punch_id: string | null; check_out_punch_id: string | null;
  }>(
    `SELECT r.*, e.employee_code, e.geofence_enabled
       FROM records r
       JOIN employees e ON e.id = r.employee_id
      ${where.length ? "WHERE " + where.join(" AND ") : ""}
      ORDER BY r.attendance_day DESC, r.check_in_at DESC NULLS LAST
      LIMIT $${params.length}`,
    params,
  );

  const now = new Date();
  return rows.map((row) => {
    const v = verdictFor(row.check_in_lat, row.check_in_lng, numOrNull(row.check_in_accuracy_m), ctx, row.geofence_enabled);
    return {
      punchId: row.punch_id ?? row.id,
      employeeId: row.employee_code,
      kind: row.check_out_at ? "complete" : row.check_in_at ? "in" : "out",
      istDate: toDayKey(row.attendance_day),
      serverTime: formatISTClock(row.check_in_at ?? now),
      insideGeofence: v.inside,
      distanceM: v.distance,
      note: v.note,
      duplicate: false,
      closedPriorDay: null,
    };
  });
}
