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

export function loadEnv(path = join(ROOT, ".env"), env = process.env) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return env; // no .env: the caller is relying on real environment variables
  }

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
    if (env[key] === undefined) env[key] = value;
  }
  return env;
}

export const REPO_ROOT = ROOT;

/**
 * The same chain Next.js uses, so `npm run db:migrate` and the running server agree
 * about which database they mean. .env.local is the developer's override and is
 * never committed; loading it second is what makes it win over .env while still
 * losing to a variable genuinely set in the environment.
 */
export function loadEnvChain(env = process.env) {
  loadEnv(join(ROOT, ".env"), env);
  loadEnv(join(ROOT, ".env.local"), env);
  return env;
}
