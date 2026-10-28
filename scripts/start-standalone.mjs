/**
 * scripts/start-standalone.mjs -- assemble and run the deployable payload.
 *
 * `next build` with `output: "standalone"` emits `.next/standalone/` containing
 * `server.js`, a pruned `node_modules/` and a `package.json` -- and deliberately
 * NOT `.next/static` or `public/`, which Next expects the image to place inside it.
 * This script is that placement step, and then it starts the server it just built.
 *
 * It exists as a file rather than four lines in a Dockerfile RUN because the
 * artifact has to be assembled the same way in both places, and the thing that
 * makes the deploy safe -- nothing outside this directory is reachable -- is only
 * worth claiming if it is the same directory the probe test runs against.
 *
 * Usage:  node scripts/start-standalone.mjs
 *         HOSTNAME=127.0.0.1 PORT=3000 node scripts/start-standalone.mjs
 */

import { cpSync, existsSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BUILD = join(ROOT, ".next");
const STANDALONE = join(BUILD, "standalone");

function die(msg) {
  console.error(`[vkon] ${msg}`);
  process.exit(1);
}

if (!existsSync(join(STANDALONE, "server.js"))) {
  die("no .next/standalone/server.js -- run `npm run build` first");
}

/* ------------------------------------------------------------ assemble the payload */

// Everything below is copied INTO the standalone directory so that directory alone
// is the application. Nothing is copied out of the repository, so the repository
// itself -- .git, server/, db/, scripts/, .env -- never has to be reachable.
const COPIES = [
  { from: join(BUILD, "static"), to: join(STANDALONE, ".next", "static") },
  { from: join(ROOT, "public"), to: join(STANDALONE, "public") },
];

for (const { from, to } of COPIES) {
  if (!existsSync(from)) continue;
  // Wipe the previous copy first. `cpSync` merges, so a script or an image that
  // was deleted from public/ would keep being served from a stale standalone
  // directory forever -- a removed file is exactly the one you want to disappear.
  rmSync(to, { recursive: true, force: true });
  cpSync(from, to, { recursive: true });
}

// Next drops the project's .env in beside server.js so `next start`-style loading
// keeps working. The container gets its configuration from the orchestrator
// instead, and an image layer that happens to contain TUNNEL_TOKEN is a secret in
// the artifact, so it is deleted here rather than merely overridden at runtime.
for (const name of readdirSync(STANDALONE)) {
  if (/^\.env(\.|$)/.test(name)) rmSync(join(STANDALONE, name), { force: true });
}

// Fail loudly rather than boot half a portal: an asset referenced by index.html
// that is not in the payload is a 404 the browser will show as a broken page.
const MISSING = [];
for (const req of [
  "public/index.html", "public/admin.html", "public/shared.js",
  "public/app.js", "public/admin.js", "public/styles.css",
]) {
  if (!existsSync(join(STANDALONE, req))) MISSING.push(req);
}
if (!existsSync(join(STANDALONE, ".next", "static"))) MISSING.push(".next/static");
if (MISSING.length) die(`payload is incomplete: ${MISSING.join(", ")}`);

/* ------------------------------------------------------------------------- run it */

// BIND_HOST, not HOSTNAME: on Linux HOSTNAME is already set to the machine's name,
// and reading it as a bind address would make the server try to listen on an
// interface it does not have. Loopback by default because a developer laptop should
// not start an attendance server on the café network; the container sets
// BIND_HOST=0.0.0.0 so cloudflared can reach it, and publishes nothing publicly.
const bindHost = process.env.BIND_HOST || "127.0.0.1";
const port = Number(process.env.PORT || 3000);

// The names Next's own server.js reads.
process.env.HOSTNAME = bindHost;
process.env.PORT = String(port);

if (!statSync(join(STANDALONE, "server.js")).isFile()) die("server.js is missing");

const pkg = JSON.parse(readFileSync(join(STANDALONE, "package.json"), "utf8"));
const pruned = readdirSync(join(STANDALONE, "node_modules")).length;
console.log(`[vkon] ${pkg.name} standalone: ${pruned} pruned packages, ` +
            `listening on http://${bindHost}:${port}`);
console.log(`[vkon] served root is ${STANDALONE}; nothing above it is reachable`);

// Required in-process rather than spawned as a child: this is the container's PID 1
// and must take SIGTERM from `docker stop` itself, instead of leaving a listener
// running after its parent exits.
createRequire(join(STANDALONE, "resolve.js"))("./server.js");
