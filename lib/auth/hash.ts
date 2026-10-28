/**
 * lib/auth/hash.ts -- password hashing, and the timing equality that goes with it.
 *
 * bcryptjs, not argon2 (D4): pure JavaScript, so the Docker build needs no compiler
 * and no native toolchain. That is not a preference, it is what makes this deployable
 * on a low-end host where `npm ci` on a native module is the reason an image never
 * gets built.
 *
 * Two properties this file is responsible for:
 *
 *   1. Cost. One hash should cost 150-250 ms on the machine that runs it -- high
 *      enough that an offline attack is expensive, low enough that a person on a
 *      phone does not think sign-in failed. `scripts/bcrypt-calibrate.mjs` measures
 *      the current environment and prints the factor that lands in that band;
 *      BCRYPT_COST_FACTOR is set from that measurement, not from a guess.
 *   2. Equal time for an unknown username. A login for an account that does not exist
 *      must still cost one bcrypt verification, otherwise response time tells an
 *      attacker which names are real before they have guessed a single password. See
 *      dummyHash() -- and note that the dummy is generated at runtime rather than
 *      committed, because a bcrypt string sitting in a source file is what a leak
 *      looks like to the public-repository guard, and rightly so.
 */

import { createHash } from "node:crypto";
import bcrypt from "bcryptjs";
import { config } from "../config";

/** bcrypt ignores everything past the 72nd byte of the password. Pre-hashing with
 *  SHA-256 and encoding it as base64 (44 characters) means a long passphrase is
 *  either accepted in full or not at all -- never silently truncated so that two
 *  different passwords both work. */
function preHash(password: string): string {
  return createHash("sha256").update(password, "utf8").digest("base64");
}

/** The work factor for a new hash, from the environment. */
export function cost(): number {
  return config().bcryptCost;
}

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(preHash(password), cost());
}

/**
 * Verify a candidate against a stored hash. Returns false for a missing or malformed
 * hash rather than throwing, so a caller cannot tell "no password set" from "wrong
 * password" through an exception path -- both are a failed sign-in.
 */
export async function verifyPassword(password: string, stored: string | null | undefined): Promise<boolean> {
  if (!stored) return false;
  if (!/^\$2[aby]\$\d{2}\$/.test(stored)) return false;
  try {
    return await bcrypt.compare(preHash(password), stored);
  } catch {
    return false;
  }
}

/**
 * A hash of a value nobody knows, made once per process at the configured cost.
 * Login compares the submitted password against this when the username does not
 * exist, so an unknown user costs exactly what a known user costs.
 *
 * Generated rather than written as a literal for two reasons: the cost factor is an
 * environment setting and a literal would silently disagree with it, and a committed
 * string shaped like a password hash is what the public-repository guard exists to
 * fail builds over.
 */
let dummy: Promise<string> | null = null;

export function dummyHash(): Promise<string> {
  if (!dummy) dummy = bcrypt.hash(preHash(`dummy-${process.pid}-${Date.now()}`), cost());
  return dummy;
}

/** True when a stored hash was made with a lower cost than we now require. */
export function needsRehash(stored: string | null | undefined): boolean {
  if (!stored) return false;
  try {
    return bcrypt.getRounds(stored) < cost();
  } catch {
    return true;
  }
}

/**
 * The password policy the server enforces. Deliberately short: length is the term
 * that actually resists an offline crack, and a composition rule ("one symbol, one
 * digit, one uppercase") is well documented as producing passwords that are harder
 * for the person and easier for the attacker.
 *
 * There is no denylist of known-bad passwords in this file, and that is not an
 * oversight: the values an earlier build shipped as defaults are burned and public,
 * and naming them here would put them back into a committed source file -- which the
 * public-repository guard treats as a leak, correctly. The denylist is data, owned by
 * the settings table (M9), not code.
 */
export const PASSWORD_MIN_LENGTH = 10;
export const PASSWORD_MAX_LENGTH = 256;

export interface PasswordProblem {
  /** Stable machine-readable reason; never contains the password. */
  code: "too_short" | "too_long" | "matches_username" | "matches_employee_code" | "unchanged";
  message: string;
}

export function checkPasswordPolicy(
  password: string,
  account: { username: string; employeeCode?: string | null; currentHash?: string | null },
): PasswordProblem | null {
  const problem = (code: PasswordProblem["code"], message: string): PasswordProblem => ({ code, message });

  if (password.length < PASSWORD_MIN_LENGTH) {
    return problem("too_short", `A password must be at least ${PASSWORD_MIN_LENGTH} characters.`);
  }
  if (password.length > PASSWORD_MAX_LENGTH) {
    return problem("too_long", `A password must be at most ${PASSWORD_MAX_LENGTH} characters.`);
  }

  const lowered = password.toLowerCase();
  const username = (account.username || "").toLowerCase();
  // The identity is on every payslip and every notice board in the building, so a
  // password that contains it is not a secret.
  if (username && (lowered === username || lowered.includes(username) || username.includes(lowered))) {
    return problem("matches_username", "That password is too close to the sign-in name.");
  }
  const code = (account.employeeCode || "").toLowerCase();
  if (code && lowered.includes(code)) {
    return problem("matches_employee_code", "That password contains the employee code.");
  }

  return null;
}

/**
 * The change-password endpoint needs to know whether the person is trying to reuse
 * the password they already have -- but only when they were required to prove the
 * current one. Comparing hashes is the only way to ask this without the caller
 * having supplied the current password.
 */
export async function isSamePassword(password: string, stored: string | null | undefined): Promise<boolean> {
  return verifyPassword(password, stored);
}
