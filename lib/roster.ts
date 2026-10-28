/**
 * lib/roster.ts -- the employee directory, read and written the way the roles allow.
 *
 * Two decisions shape this file and are the reason it is a module rather than SQL in a
 * handler:
 *
 *   1. READ IS SCOPED BY ROLE, SERVER-SIDE. What a caller may see is decided from the
 *      session row's role, never from a query string they control: an admin sees the whole
 *      roster, a manager sees themselves and the people who report to them, an employee
 *      sees only themselves. The old browser filtered the same way client-side
 *      (`getDirectReports` in shared.js), which is a filter anyone can delete in devtools;
 *      the scope lives here so it cannot be talked out of.
 *   2. WRITE IS ADMIN-ONLY, and this module owns only the *how*. The *whether* (403) is the
 *      route's job, checked against `session.role` from requireSession(); by the time a
 *      function below runs, the caller is already known to be an admin. What is left here is
 *      turning a request into a valid row: the field rules the schema also enforces, the
 *      manager-code-to-uuid resolution, and translating a constraint violation into an error
 *      that names the field rather than the index.
 *
 * The cycle rule (M7a) is deliberately NOT re-implemented here. The constraint trigger is the
 * single source of truth for "this manager pointer closes a loop"; this module's only job is
 * to recognise the resulting check violation and say so in a message a person can act on.
 */

import type { PoolClient } from "pg";
import { query, withTransaction, PG, pgCode } from "./db/pool";
import { ApiError, badRequest } from "./http/errors";

/** The access role, exactly as the schema's CHECK constrains it. */
export type AccessRole = "employee" | "manager" | "admin";
const ACCESS_ROLES: readonly AccessRole[] = ["employee", "manager", "admin"];

/** Who is asking, as far as scoping needs it. `AuthSession` satisfies this structurally. */
export interface RosterViewer {
  employeeId: string;
  employeeCode: string;
  role: AccessRole;
}

/**
 * The per-employee contract `/api/employees` speaks. It is the portal's own field names where
 * they already exist (so a roster screen needs no rename layer) plus the two server-only facts
 * the browser could not be trusted with before: `accessRole` (what authorises, distinct from
 * the displayed `jobTitle`) and `active` (what gates every request). The uuid and the password
 * hash never appear.
 */
export interface RosterRow {
  id: string;
  name: string;
  username: string;
  email: string | null;
  jobTitle: string | null;
  department: string | null;
  accessRole: AccessRole;
  managerId: string | null;
  monthlySalary: number | null;
  geofenceEnabled: boolean;
  active: boolean;
  joinedOn: string | null;
}

interface EmployeeRow {
  employee_code: string;
  name: string;
  username: string;
  email: string | null;
  job_title: string | null;
  department: string | null;
  role: string;
  manager_code: string | null;
  monthly_salary: string | number | null;
  geofence_enabled: boolean;
  active: boolean;
  joined_on: Date | string | null;
}

const SELECT_COLUMNS = `
  e.employee_code, e.name, e.username, e.email, e.job_title, e.department, e.role,
  e.monthly_salary, e.geofence_enabled, e.active, e.joined_on,
  m.employee_code AS manager_code`;

const FROM_JOIN = `FROM employees e LEFT JOIN employees m ON m.id = e.manager_id`;

function toDayKey(v: Date | string | null): string | null {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) {
    const y = v.getFullYear();
    const mm = String(v.getMonth() + 1).padStart(2, "0");
    const dd = String(v.getDate()).padStart(2, "0");
    return `${y}-${mm}-${dd}`;
  }
  return String(v).slice(0, 10);
}

function money(v: string | number | null): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function shape(r: EmployeeRow): RosterRow {
  return {
    id: r.employee_code,
    name: r.name,
    username: r.username,
    email: r.email,
    jobTitle: r.job_title,
    department: r.department,
    accessRole: r.role as AccessRole,
    managerId: r.manager_code,
    monthlySalary: money(r.monthly_salary),
    geofenceEnabled: r.geofence_enabled,
    active: r.active,
    joinedOn: toDayKey(r.joined_on),
  };
}

/**
 * The roster a viewer is allowed to see.
 *
 * The three scopes are three predicates on the same join, so "manager sees their reports"
 * is one WHERE clause and not a second code path that can drift from the first. A manager's
 * own row is included because a person's screen has to be able to describe the person using
 * it; the reports are the depth-1 direct reports `getDirectReports` returns today, and the
 * chain is walked upward, not downward, only where an approval needs it (M8).
 */
export async function listRoster(viewer: RosterViewer): Promise<RosterRow[]> {
  if (viewer.role === "admin") {
    const rows = await query<EmployeeRow>(
      `SELECT ${SELECT_COLUMNS} ${FROM_JOIN} ORDER BY e.employee_code`,
    );
    return rows.map(shape);
  }

  if (viewer.role === "manager") {
    const rows = await query<EmployeeRow>(
      `SELECT ${SELECT_COLUMNS} ${FROM_JOIN}
        WHERE e.id = $1 OR e.manager_id = $1
        ORDER BY (e.id = $1) DESC, e.employee_code`,
      [viewer.employeeId],
    );
    return rows.map(shape);
  }

  // An employee is entitled to exactly their own row -- and to nothing else, whatever they
  // put in the query string. Returning one row rather than honouring a requested code is the
  // point: the request cannot widen the scope.
  const rows = await query<EmployeeRow>(
    `SELECT ${SELECT_COLUMNS} ${FROM_JOIN} WHERE e.id = $1`,
    [viewer.employeeId],
  );
  return rows.map(shape);
}

/** The direct reports of one employee, by code -- the depth-1 team list a manager sees. */
export async function directReports(managerCode: string): Promise<RosterRow[]> {
  const rows = await query<EmployeeRow>(
    `SELECT ${SELECT_COLUMNS}
       FROM employees e
       LEFT JOIN employees m ON m.id = e.manager_id
      WHERE e.manager_id = (SELECT id FROM employees WHERE employee_code = $1)
      ORDER BY e.employee_code`,
    [managerCode],
  );
  return rows.map(shape);
}

/** A new employee, as an admin asked for it (after the route's field parsing). */
export interface NewEmployee {
  employeeCode: string;
  username: string;
  name: string;
  email: string | null;
  jobTitle: string | null;
  department: string | null;
  accessRole: AccessRole;
  managerCode: string | null;
  monthlySalary: number | null;
  geofenceEnabled: boolean;
  active: boolean;
  joinedOn: string | null;
}

export interface EmployeePatch {
  name?: string;
  email?: string | null;
  jobTitle?: string | null;
  department?: string | null;
  accessRole?: AccessRole;
  managerCode?: string | null;
  monthlySalary?: number | null;
  geofenceEnabled?: boolean;
  active?: boolean;
  joinedOn?: string | null;
}

/** Resolve a manager's portal code to its uuid, or throw. Runs on the caller's client so it
 *  reads the same snapshot as the write it feeds (a pool query would read outside the tx). */
async function resolveManagerId(client: PoolClient, managerCode: string): Promise<string> {
  const res = await client.query<{ id: string }>(
    `SELECT id FROM employees WHERE employee_code = $1`,
    [managerCode],
  );
  const row = res.rows[0];
  if (!row) throw badRequest(`No employee matches manager code \`${managerCode}\`.`, "unknown_manager");
  return row.id;
}

/** A check violation from the schema/trigger, phrased as the field the admin got wrong. */
function translateWriteError(err: unknown, context: { code: string }): never {
  const code = pgCode(err);
  if (code === PG.uniqueViolation) {
    throw new ApiError(409, `That code, username, or email is already in use.`, {
      reason: "duplicate_employee",
    });
  }
  if (code === PG.foreignKeyViolation) {
    throw badRequest("That manager does not exist.", "unknown_manager");
  }
  if (code === PG.checkViolation) {
    // 0002's CHECK (salary, role, code case, email shape) and 0007's cycle trigger all raise
    // this code. By the time a row reaches the database the lib has already applied every
    // CHECK except the chain walk, so the honest reading of a surviving check violation is
    // "the manager chain closed a loop" -- which is exactly the message a person can use.
    throw badRequest(
      `That manager assignment would create a reporting loop for \`${context.code}\`.`,
      "manager_cycle",
    );
  }
  throw err;
}

/**
 * Insert one employee. Everything happens in one transaction so the manager lookup and the
 * insert see the same snapshot; a cycle or a duplicate is refused and nothing partial is left.
 */
export async function createEmployee(cmd: NewEmployee): Promise<RosterRow> {
  validateRole(cmd.accessRole);
  if (cmd.monthlySalary !== null && cmd.monthlySalary < 0) {
    throw badRequest("`monthlySalary` cannot be negative.", "invalid_salary");
  }

  return withTransaction(async (client) => {
    const managerId = cmd.managerCode ? await resolveManagerId(client, cmd.managerCode) : null;
    try {
      await client.query(
        `INSERT INTO employees
           (employee_code, username, name, email, job_title, department, role, manager_id,
            monthly_salary, geofence_enabled, active, joined_on, timezone)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::date, 'Asia/Kolkata')`,
        [
          cmd.employeeCode.toUpperCase(),
          cmd.username.toLowerCase(),
          cmd.name,
          cmd.email,
          cmd.jobTitle,
          cmd.department,
          cmd.accessRole,
          managerId,
          cmd.monthlySalary,
          cmd.geofenceEnabled,
          cmd.active,
          cmd.joinedOn,
        ],
      );
      // Read back through the same join the GET uses, so a created row is shaped exactly like
      // one listed -- same date formatting, same manager code -- rather than from the command.
      const created = await client.query<EmployeeRow>(
        `SELECT ${SELECT_COLUMNS} ${FROM_JOIN} WHERE e.employee_code = $1`,
        [cmd.employeeCode.toUpperCase()],
      );
      return shape(created.rows[0]);
    } catch (err) {
      translateWriteError(err, { code: cmd.employeeCode });
    }
  });
}

/**
 * Patch an existing employee by portal code. Only the fields present in `patch` are touched;
 * `managerCode` (when provided) is resolved to a uuid and re-triggers the cycle check, so an
 * admin re-parenting a manager under one of their own reports is refused here and by 0007.
 */
export async function updateEmployee(code: string, patch: EmployeePatch): Promise<RosterRow> {
  const upper = code.toUpperCase();

  if (patch.accessRole !== undefined) validateRole(patch.accessRole);
  if (patch.monthlySalary !== undefined && patch.monthlySalary !== null && patch.monthlySalary < 0) {
    throw badRequest("`monthlySalary` cannot be negative.", "invalid_salary");
  }

  return withTransaction(async (client) => {
    const exists = await client.query<{ id: string }>(
      `SELECT id FROM employees WHERE employee_code = $1`,
      [upper],
    );
    if (!exists.rows[0]) throw new ApiError(404, `There is no employee \`${upper}\`.`, { reason: "no_such_employee" });

    // Build the SET list from only the keys the caller actually sent, so a PATCH of `active`
    // does not rewrite a nullable column it was never asked about back to null.
    const sets: string[] = [];
    const params: unknown[] = [];
    const add = (column: string, value: unknown) => {
      params.push(value);
      sets.push(`${column} = $${params.length}`);
    };

    if (patch.name !== undefined) add("name", patch.name);
    if (patch.email !== undefined) add("email", patch.email);
    if (patch.jobTitle !== undefined) add("job_title", patch.jobTitle);
    if (patch.department !== undefined) add("department", patch.department);
    if (patch.accessRole !== undefined) add("role", patch.accessRole);
    if (patch.monthlySalary !== undefined) add("monthly_salary", patch.monthlySalary);
    if (patch.geofenceEnabled !== undefined) add("geofence_enabled", patch.geofenceEnabled);
    if (patch.active !== undefined) add("active", patch.active);
    if (patch.joinedOn !== undefined) add("joined_on", patch.joinedOn);
    if (patch.managerCode !== undefined) {
      const managerId = patch.managerCode ? await resolveManagerId(client, patch.managerCode) : null;
      add("manager_id", managerId);
    }

    try {
      if (sets.length) {
        params.push(upper);
        await client.query(
          `UPDATE employees SET ${sets.join(", ")} WHERE employee_code = $${params.length}`,
          params,
        );
      }
      const row = await client.query<EmployeeRow>(
        `SELECT ${SELECT_COLUMNS} ${FROM_JOIN} WHERE e.employee_code = $1`,
        [upper],
      );
      // `row` is guaranteed: the existence check above and this read are in one transaction.
      return shape(row.rows[0]);
    } catch (err) {
      translateWriteError(err, { code: upper });
    }
  });
}

function validateRole(role: AccessRole): void {
  if (!ACCESS_ROLES.includes(role)) {
    throw badRequest("`accessRole` must be one of employee, manager, admin.", "invalid_role");
  }
}
