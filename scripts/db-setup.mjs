/**
 * scripts/db-setup.mjs -- create the application role and its grants. Idempotent.
 *
 * Two roles, and the split is the point:
 *
 *   attendance_owner  owns the schema and runs migrations. It can CREATE, ALTER and
 *                     DROP. The API never connects as this user.
 *   attendance_app    what the API connects as. DML only, on tables the owner has
 *                     already made. It cannot create a table, a trigger or a
 *                     function, so an SQL injection in a route handler cannot
 *                     install something that rewrites attendance history -- it can
 *                     only reach the rows the grants below allow.
 *
 * The default privileges are granted here, before the first migration, so a table
 * created later is reachable by the app role the moment it exists. Run this after
 * migrating too: the `ON ALL TABLES` grants only cover what exists at the time, and
 * re-running is free because every statement in here is idempotent by design.
 *
 * One deliberate exception is added by 0005_audit.sql, not here: audit_log is
 * append-only, so the app role gets INSERT and SELECT on it and never UPDATE or
 * DELETE, even though the general grant below would hand it all four. That
 * migration revokes them again after this script has run.
 *
 * Usage: node scripts/db-setup.mjs
 */

import { loadEnvChain } from "./lib/env.mjs";
import { withOwnerClient } from "./lib/db-config.mjs";

loadEnvChain();

const APP_ROLE = process.env.ATTENDANCE_APP_USER || "attendance_app";
const APP_PASSWORD = process.env.ATTENDANCE_APP_PASSWORD || "";

function identifier(name) {
  if (!/^[a-z_][a-z0-9_]*$/i.test(name)) {
    throw new Error(`refusing to use ${JSON.stringify(name)} as an identifier`);
  }
  return name;
}

function quotedLiteral(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

async function main() {
  const role = identifier(APP_ROLE);

  await withOwnerClient(async (client) => {
    // POSTGRES_DB is authoritative because it is the name the container was actually
    // initialised with. Falling back to what the connection string parsed out of the
    // path means this works with either variable set, and `pg` normalises a
    // connectionString into connectionParameters.database -- there is no
    // connectionParameters.connectionString to read.
    const database = identifier(
      process.env.POSTGRES_DB || client.connectionParameters.database || "",
    );
    if (!database) throw new Error("cannot work out the database name: set POSTGRES_DB or put it in DATABASE_URL_OWNER");

    const owner = (await client.query("SELECT current_user AS u")).rows[0].u;

    // CREATE ROLE cannot be parameterised, so the name is validated above and
    // quoted by hand. Everything that takes a value uses $1.
    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = ${quotedLiteral(role)}) THEN
          CREATE ROLE ${role} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
            NOINHERIT NOREPLICATION CONNECTION LIMIT 20;
        END IF;
      END
      $$`);

    // A role that already existed may have been created with a different shape by
    // an earlier release; assert the attributes this application needs rather than
    // hoping the create branch ran with them. NOINHERIT is on purpose: membership in
    // no other role means no accidental route to the owner's privileges.
    await client.query(`ALTER ROLE ${role} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`);

    if (APP_PASSWORD) {
      await client.query(`ALTER ROLE ${role} PASSWORD ${quotedLiteral(APP_PASSWORD)}`);
      console.log(`[setup] role ${role}: password set from ATTENDANCE_APP_PASSWORD`);
    } else {
      console.log(`[setup] role ${role}: existing password kept (ATTENDANCE_APP_PASSWORD unset)`);
    }

    await client.query(`GRANT CONNECT ON DATABASE ${identifier(database)} TO ${role}`);

    // Postgres 15 removed CREATE on schema public from PUBLIC; saying it again keeps
    // the intent true on an older server and costs nothing on a newer one. The app
    // role must not be able to make a table, and USAGE is all it needs to read and
    // write the ones the owner made.
    await client.query("REVOKE CREATE ON SCHEMA public FROM PUBLIC");
    await client.query(`GRANT USAGE ON SCHEMA public TO ${role}`);

    await client.query(`
      GRANT SELECT, INSERT, UPDATE, DELETE
        ON ALL TABLES IN SCHEMA public TO ${role}`);
    await client.query(`
      GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${role}`);

    // The ordering rule: default privileges are attached to the creating role, which
    // is whoever runs migrations. Doing this FOR PUBLIC would also grant on objects
    // belonging to roles this application does not control.
    await client.query(`
      ALTER DEFAULT PRIVILEGES FOR ROLE ${quotedIdentifier(owner)} IN SCHEMA public
        GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${role}`);
    await client.query(`
      ALTER DEFAULT PRIVILEGES FOR ROLE ${quotedIdentifier(owner)} IN SCHEMA public
        GRANT USAGE, SELECT ON SEQUENCES TO ${role}`);

    // Re-assert the one table the blanket grant above must not reach. This has to live
    // here as well as in 0005_audit.sql because the ordering is not fixed: run db:setup
    // after migrating and GRANT ON ALL TABLES hands UPDATE and DELETE back to the app
    // role, including on the audit log -- which would undo the append-only rule as a
    // side effect of an unrelated re-run. The trigger in 0005 still refuses the write,
    // so this is tidiness rather than the protection; the protection is the trigger.
    await client.query(`
      DO $$
      BEGIN
        IF to_regclass('public.audit_log') IS NOT NULL THEN
          REVOKE UPDATE, DELETE, TRUNCATE ON audit_log FROM ${role};
          GRANT INSERT, SELECT ON audit_log TO ${role};
          REVOKE UPDATE, DELETE ON audit_log_id_seq FROM ${role};
          GRANT USAGE, SELECT ON audit_log_id_seq TO ${role};
        END IF;
      END
      $$`);

    console.log(`[setup] database ${database}: role ${role} ready, owner ${owner}`);
  });
}

function quotedIdentifier(name) {
  if (!/^[a-z_][a-z0-9_]*$/i.test(name)) {
    throw new Error(`refusing to use ${JSON.stringify(name)} as an identifier`);
  }
  return `"${name.replace(/"/g, '""')}"`;
}

main()
  .then(() => console.log("[setup] done. Next: node scripts/db-migrate.mjs"))
  .catch((e) => {
    console.error(`[setup] ERROR: ${e.message}`);
    process.exit(1);
  });
