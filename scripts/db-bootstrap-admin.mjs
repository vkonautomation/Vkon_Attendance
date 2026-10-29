/**
 * scripts/db-bootstrap-admin.mjs -- create the FIRST administrator. Works in production.
 *
 * This is the "documented bootstrap" docs/cutover.md step 3 refers to but that did not
 * exist: scripts/db-seed.mjs refuses on VKON_ENV=production (a synthetic roster must
 * never reach a real database), so on a fresh production box there would be no row in
 * `employees` with a password_hash and therefore no way to sign in at all. One admin is
 * the minimum that makes the backend usable, and from there the roster is grown through
 * the portal's own admin console (M7) rather than by seeding people nobody authored.
 *
 * Credentials come from the environment, the same switch .env.example already documents:
 *
 *   VKON_ADMIN_USERNAME   (default "admin", forced lower -- it is the sign-in name)
 *   VKON_ADMIN_PASSWORD   (if set: used verbatim, no forced change -- the operator's choice)
 *   VKON_ADMIN_EMPLOYEE_CODE (default "ADMIN", forced upper)
 *   VKON_ADMIN_NAME       (default "Attendance Administrator")
 *   VKON_ADMIN_EMAIL      (optional; must satisfy the employees.email CHECK)
 *
 * When VKON_ADMIN_PASSWORD is unset a one-time password is generated, printed exactly
 * once, and the account is flagged password_change_required so it cannot survive as a
 * permanent default. When it is set, the password is never echoed and no change is
 * forced -- the operator supplied a real secret deliberately.
 *
 * Idempotent and non-destructive: if the username or employee code already exists the
 * existing account is left completely alone (its password is never reset by a re-run).
 *
 * Usage: node scripts/db-bootstrap-admin.mjs   (connects as the owner role)
 */

import { createHash, randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { loadEnvChain } from "./lib/env.mjs";
import { withOwnerClient } from "./lib/db-config.mjs";

const require = createRequire(import.meta.url);
const bcrypt = require("bcryptjs");

loadEnvChain();

// Keep the two password-policy floors in step with lib/auth/hash.ts. A bootstrap that
// minted an 8-character admin would be a weaker door than the change-password form.
const PASSWORD_MIN_LENGTH = 10;
const PASSWORD_MAX_LENGTH = 256;

const USERNAME = (process.env.VKON_ADMIN_USERNAME || "admin").trim().toLowerCase();
const EMPLOYEE_CODE = (process.env.VKON_ADMIN_EMPLOYEE_CODE || "ADMIN").trim().toUpperCase();
const NAME = (process.env.VKON_ADMIN_NAME || "Attendance Administrator").trim();
const EMAIL = (process.env.VKON_ADMIN_EMAIL || "").trim() || null;
const COST = Number(process.env.BCRYPT_COST_FACTOR || 11);
const PROVIDED = process.env.VKON_ADMIN_PASSWORD || "";

/** The same SHA-256 -> base64 pre-hash lib/auth/hash.ts applies before bcrypt. */
function preHash(password) {
  return createHash("sha256").update(password, "utf8").digest("base64");
}

function assertValidIdentifier() {
  if (!/^[a-z0-9._-]{2,64}$/.test(USERNAME)) {
    throw new Error(`VKON_ADMIN_USERNAME ${JSON.stringify(USERNAME)} is not a valid sign-in name`);
  }
  if (!/^[A-Z0-9._-]{1,32}$/.test(EMPLOYEE_CODE)) {
    throw new Error(`VKON_ADMIN_EMPLOYEE_CODE ${JSON.stringify(EMPLOYEE_CODE)} is not a valid code`);
  }
  if (EMAIL && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(EMAIL)) {
    throw new Error("VKON_ADMIN_EMAIL is not a well-formed address");
  }
}

function assertPasswordPolicy(password) {
  if (password.length < PASSWORD_MIN_LENGTH) {
    throw new Error(`VKON_ADMIN_PASSWORD must be at least ${PASSWORD_MIN_LENGTH} characters`);
  }
  if (password.length > PASSWORD_MAX_LENGTH) {
    throw new Error(`VKON_ADMIN_PASSWORD must be at most ${PASSWORD_MAX_LENGTH} characters`);
  }
  const lowered = password.toLowerCase();
  if (lowered === USERNAME || lowered.includes(USERNAME) || USERNAME.includes(lowered)) {
    throw new Error("VKON_ADMIN_PASSWORD must not be or contain the sign-in name");
  }
}

async function main() {
  assertValidIdentifier();

  const generated = !PROVIDED;
  const password = generated ? randomBytes(18).toString("base64url") : PROVIDED;
  if (!generated) assertPasswordPolicy(password);

  // The cost floor here matches hash.ts's band; a too-cheap admin hash is the leak this
  // file is meant to avoid, so refuse rather than mint a weak one from a bad env value.
  if (!Number.isInteger(COST) || COST < 8 || COST > 14) {
    throw new Error(`BCRYPT_COST_FACTOR must be an integer 8-14, got ${JSON.stringify(process.env.BCRYPT_COST_FACTOR)}`);
  }
  const hash = await bcrypt.hash(preHash(password), COST);

  await withOwnerClient(async (client) => {
    const clash = await client.query(
      "SELECT username, employee_code FROM employees WHERE username = $1 OR employee_code = $2 LIMIT 1",
      [USERNAME, EMPLOYEE_CODE],
    );
    if ((clash.rowCount ?? 0) > 0) {
      const r = clash.rows[0];
      console.log(`[admin] an account already holds username=${r.username} code=${r.employee_code}; left untouched (password NOT reset)`);
      return;
    }

    // active TRUE so it can sign in immediately; role admin so it can authorise the
    // roster and settings; password_change_required only when we minted a throwaway.
    await client.query(
      `INSERT INTO employees
         (employee_code, username, name, email, role, active,
          password_hash, password_changed_at, password_change_required, timezone)
       VALUES ($1, $2, $3, $4, 'admin', TRUE, $5, now(), $6, 'Asia/Kolkata')`,
      [EMPLOYEE_CODE, USERNAME, NAME, EMAIL, hash, generated],
    );

    console.log(`[admin] created administrator: username=${USERNAME} code=${EMPLOYEE_CODE} role=admin active=true forced_change=${generated}`);
    if (generated) {
      console.log(`[admin] TEMPORARY password (sign in once; it forces a change): ${password}`);
    } else {
      console.log("[admin] password taken from VKON_ADMIN_PASSWORD (not echoed).");
    }
  });
}

main()
  .then(() => console.log("[admin] done."))
  .catch((e) => {
    console.error(`[admin] ERROR: ${e.message}`);
    process.exit(1);
  });
