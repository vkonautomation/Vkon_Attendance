/**
 * scripts/lib/env.mjs -- read the repository's .env for command-line scripts.
 *
 * Next.js does this for the server automatically, which is why the API never needs
 * it. A bare `node scripts/db-migrate.mjs` does, and without it every database
 * command would have to be written as `set -a; . .env; set +a; npm run db:migrate`.
 *
 * It is ~25 lines rather than the `dotenv` package because the runtime dependency
 * list is a security surface: next, react, react-dom, pg, bcryptjs and nothing
 * else, so that a low-end host builds the image without a compiler and an audit has
 * a short list to read. `dotenv` would be harmless -- and it would still be the
 * start of a list that grows.
 *
 * Values already in the environment win. That is what makes CI and a container's
 * `environment:` block authoritative over whatever is in a checkout.
 */

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

export function loadEnv(path = join(ROOT, ".env"), env = process.env, opts = {}) {
  const { override = false, present = null } = opts;
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return env; // no .env: the caller is relying on real environment variables
  }

  // Keys this file has already set. Without it, a file with the same key twice -- someone
  // appending a correction below a stale line -- would keep the stale one, because after
  // the first assignment `env[key]` is no longer undefined. Last-wins is what the person
  // editing the file means, and what dotenv does.
  const seen = new Set();

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    // Only a quoted value may contain a space or a literal #; otherwise the
    // comment character starts a trailing comment.
    const quoted = /^(".*"|'.*')$/.test(value);
    if (quoted) {
      value = value.slice(1, -1);
    } else {
      const hash = value.indexOf(" #");
      if (hash >= 0) value = value.slice(0, hash).trim();
    }
    // A variable that was genuinely in the environment when the process started is
    // authoritative over every file. `present` is the snapshot taken before the first
    // file was read, because `env[key] !== undefined` alone cannot tell "set from
    // outside" from "set by the .env line read a moment ago" -- and without that
    // distinction .env.local can never override .env, which is the entire reason a
    // second file exists. With no snapshot there is only one file, so anything already
    // in `env` came from outside unless this file put it there, which is what `seen`
    // records -- and the guard below turns on it.
    const fromEnvironment = present ? present.has(key) : false;
    if (fromEnvironment) continue;
    if (env[key] !== undefined && !override && !seen.has(key)) continue;
    env[key] = value;
    seen.add(key);
  }
  return env;
}

export const REPO_ROOT = ROOT;

/**
 * The same chain Next.js uses, so `npm run db:migrate` and the running server agree
 * about which database they mean. .env.local is the developer's override and is
 * never committed; it is loaded second, which is what makes it win over .env while
 * still losing to a variable genuinely set in the environment.
 */
export function loadEnvChain(env = process.env, root = ROOT) {
  const fromEnvironment = new Set(Object.keys(env));
  loadEnv(join(root, ".env"), env, { present: fromEnvironment });
  loadEnv(join(root, ".env.local"), env, { override: true, present: fromEnvironment });
  return env;
}
