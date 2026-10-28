/**
 * tests/unit/env.mjs -- the environment loader that every database script depends on.
 *
 * This exists because of a bug found while writing M2, not as coverage for its own
 * sake: `scripts/db-seed.mjs` reads VKON_ENV to decide whether seeding is allowed, and
 * `.env.local` was silently unable to override `.env`. The refusal fired the other way
 * round -- a laptop running against a throwaway database was told it was production --
 * which is the failure mode a precedence rule has when the rule is expressed as
 * "only set it if it is unset": the first file to be read always wins, and the
 * developer's file is never first.
 *
 * Nothing here touches the repository's real .env, so the suite is runnable on a fresh
 * clone where .env does not exist at all.
 *
 * Usage: node tests/unit/env.mjs
 */

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadEnv, loadEnvChain } from "../../scripts/lib/env.mjs";

const checks = [];

function check(name, passed, detail) {
  checks.push({ name, passed: !!passed });
  console.log(`${passed ? "ok    " : "FAIL  "} ${name}`);
  if (!passed && detail !== undefined) console.log(`        ${detail}`);
}

const dir = mkdtempSync(join(tmpdir(), "vkon-env-"));
const file = (name, text) => {
  const p = join(dir, name);
  writeFileSync(p, text, "utf8");
  return p;
};

/* ------------------------------------------------------------------------ one file */

{
  const p = file("plain.env", [
    "SET_ONE=one",
    "",
    "# a comment line",
    "   ",
    "EMPTY=",
    "QUOTED=\"has a space # and a hash\"",
    "TRAILING=value # trailing comment",
    "SINGLE='kept literally'",
    "=no key",
    "NO_EQUALS_SIGN",
    "DUPLICATED=stale",
    "DUPLICATED=corrected",
  ].join("\n"));

  const env = loadEnv(p, {});
  check("an ordinary value is read", env.SET_ONE === "one", JSON.stringify(env.SET_ONE));
  check("a comment line and a blank line are skipped", !("#" in env) && !("   " in env));
  check("KEY= is an empty string, not absent", env.EMPTY === "", String(env.EMPTY));
  check("a quoted value keeps its spaces and its #",
    env.QUOTED === "has a space # and a hash", JSON.stringify(env.QUOTED));
  check("an unquoted value stops at a trailing comment",
    env.TRAILING === "value", JSON.stringify(env.TRAILING));
  check("single quotes are also stripped", env.SINGLE === "kept literally", env.SINGLE);
  check("a line with no key is ignored", !("" in env));
  check("a line with no = is ignored", !("NO_EQUALS_SIGN" in env));
  check("the last line wins when a key is repeated in one file",
    env.DUPLICATED === "corrected", JSON.stringify(env.DUPLICATED));
}

{
  // A value that was in the environment when the process started is authoritative over
  // any file. This is what lets a container's environment:, or CI, or the test that
  // proves db:seed refuses on production, override a checkout.
  const p = file("wins.env", "VKON_ENV=production\nOTHER=from-file\n");
  const env = loadEnv(p, { VKON_ENV: "development" });
  check("a real environment variable beats the file",
    env.VKON_ENV === "development", env.VKON_ENV);
  check("a variable the environment does not mention is still read from the file",
    env.OTHER === "from-file", env.OTHER);
}

{
  const missing = join(dir, "does-not-exist.env");
  const env = { ALREADY: "kept" };
  check("a missing file is not an error", loadEnv(missing, env) === env);
  check("a missing file changes nothing", env.ALREADY === "kept" && Object.keys(env).length === 1);
}

/* ------------------------------------------------------------------- the two files */

{
  // The regression, stated as the three-way precedence the comment in env.mjs promises:
  // real environment > .env.local > .env. Expressed only as "do not overwrite anything
  // already set", the middle one is unreachable, because loading .env has already set it.
  const chainRoot = mkdtempSync(join(tmpdir(), "vkon-chain-"));
  const chainFile = (name, text) => {
    const p = join(chainRoot, name);
    writeFileSync(p, text, "utf8");
    return p;
  };
  chainFile(".env", "VKON_ENV=production\nONLY_IN_ENV=base\nPOSTGRES_DB=vkon_attendance\n");
  chainFile(".env.local", "VKON_ENV=development\nONLY_IN_LOCAL=added\n");

  const base = loadEnvChain({}, chainRoot);
  check(".env is read by the chain", base.ONLY_IN_ENV === "base", JSON.stringify(base));
  check(".env.local overrides .env (the bug this test exists for)",
    base.VKON_ENV === "development", `got ${JSON.stringify(base.VKON_ENV)}`);
  check(".env.local can add a key .env does not have", base.ONLY_IN_LOCAL === "added");
  check("a key only .env has is not lost", base.POSTGRES_DB === "vkon_attendance");

  const overridden = loadEnvChain({ VKON_ENV: "test" }, chainRoot);
  check("a real environment variable still beats .env.local",
    overridden.VKON_ENV === "test", overridden.VKON_ENV);

  const noLocal = loadEnvChain({}, dir);
  check("a directory with no .env.local yields no keys",
    Object.keys(noLocal).length === 0, JSON.stringify(noLocal));
}

const failed = checks.filter((c) => !c.passed);
console.log(`\n=== tests/unit/env.mjs: ${checks.length - failed.length}/${checks.length} checks passed ===`);
if (failed.length) {
  console.log(`>>> ${failed.length} FAILED: ${failed.map((f) => f.name).join(", ")}`);
  process.exit(1);
}
