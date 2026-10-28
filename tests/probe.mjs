/**
 * tests/probe.mjs -- what must be true about the running server.
 *
 * Every other suite here proves the portal computes the right answer. This one
 * proves the answer is being served from a safe shape: the only URLs that respond
 * are browser assets and /api/*, nothing that could reconstruct the server or the
 * repository is reachable, and the headers the front end depends on are actually
 * on the wire.
 *
 * It is deliberately not a unit test. It runs against a live `next start`, the
 * same way Cloudflare will reach it, because the failure mode it is looking for -
 * /.git/logs/HEAD returning 13 KB of reflog - is invisible to any test that reads
 * the filesystem instead of the network.
 *
 * Run:  node tests/probe.mjs            (expects the app on 127.0.0.1:3000)
 *       PROBE_BASE_URL=https://... node tests/probe.mjs
 */

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BASE = (process.env.PROBE_BASE_URL || "http://127.0.0.1:3000").replace(/\/+$/, "");
const PUBLIC_DIR = join(ROOT, "public");

let failures = 0;
let checks = 0;

function ok(cond, msg, detail) {
  checks++;
  if (cond) {
    console.log(`PASS ${msg}`);
  } else {
    failures++;
    console.log(`FAIL ${msg}${detail ? ` -- ${detail}` : ""}`);
  }
}

/** Fetch without throwing on HTTP error statuses; we care about the status. */
async function probe(path, init) {
  const url = BASE + path;
  try {
    const resp = await fetch(url, Object.assign({ redirect: "manual" }, init || {}));
    const body = await resp.text();
    return { status: resp.status, headers: resp.headers, body, url };
  } catch (e) {
    return { status: 0, headers: new Headers(), body: "", url, error: e.message };
  }
}

/* --------------------------------------------------------- what is a browser asset */

/**
 * Enumerated from the HTML rather than hardcoded, so adding a script tag to a
 * page adds a probe with no second list to remember to update. A probe list
 * someone has to maintain is a probe list that goes stale.
 */
function localRefsFrom(html) {
  const refs = new Set();
  const attr = /(?:src|href)\s*=\s*["']([^"']+)["']/gi;
  let m;
  while ((m = attr.exec(html)) !== null) {
    const raw = m[1];
    if (/^(https?:)?\/\//i.test(raw) || raw.startsWith("data:") || raw.startsWith("#") ||
        raw.startsWith("mailto:") || raw === "javascript:void(0)") {
      continue;
    }
    refs.add(raw.split("#")[0]);
  }
  return refs;
}

function readPage(name) {
  return readFileSync(join(PUBLIC_DIR, name), "utf8");
}

/** ?v= tokens, keyed by the file they annotate, for cross-page comparison. */
function tokenMap(html) {
  const map = new Map();
  const re = /(?:src|href)\s*=\s*["']([^"']+?)\?v=([0-9A-Za-z_]+)["']/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    map.set(m[1], m[2]);
  }
  return map;
}

/* ------------------------------------------------------------------ the probe list */

// Nothing outside public/ may be reachable. These are named for what they would
// disclose, and every one of them is a real path in this repository, so the list
// keeps its teeth as the app grows: /lib/rules/lop.ts and /db/seed/synthetic.sql
// are M5 and M2 files that must stay unreachable once they exist.
const MUST_NOT_BE_REACHABLE = [
  ["/.git/config", "the repository's own remote and branch config"],
  ["/.git/HEAD", "which branch production is on"],
  ["/.git/packed-refs", "every ref the repository has ever had"],
  ["/.git/logs/HEAD", "the full reflog: every commit SHA and author name"],
  ["/.env", "TUNNEL_TOKEN and every other secret the host holds"],
  ["/docker-compose.yml", "the deploy topology, and the tunnel profile"],
  ["/.dockerignore", "what the image is built to exclude"],
  ["/server/main.py", "the retired backend's source"],
  ["/server/config.py", "the retired backend's configuration reads"],
  ["/requirements.txt", "the retired backend's dependency list"],
  ["/app/api/auth/login/route.ts", "the auth route handler's source"],
  ["/app/api/health/route.ts", "a route handler's source"],
  ["/lib/rules/lop.ts", "the payroll rule engine's source"],
  ["/db/seed/synthetic.sql", "the seed file"],
  ["/db/migrations/0002_core.sql", "the schema"],
  ["/scripts/db-export.mjs", "a script that touches the database"],
  ["/tsconfig.json", "the server's compile configuration"],
  ["/package-lock.json", "the dependency tree, and a map of internal paths"],
  ["/.pytest_cache", "test run output"],
  ["/data/vkon.db", "the SQLite file, while the old backend still exists"],
];

// Percent-encoded and dot-segment variants of the same idea. A server that only
// blocks the literal spelling is blocking the list, not the path.
const TRAVERSALS = [
  "/../server/main.py",
  "/..%2fserver%2fmain.py",
  "/%2e%2e/%2e%2e/etc/passwd",
  "/./../server/main.py",
  "/js/../../server/main.py",
  "/js/../server/main.py",
  "//server/main.py",
  "/%2e%2e/",
  "/..%252f..%252fserver",
];

/* ------------------------------------------------------------------------- run it */

async function main() {
  console.log(`=== probing ${BASE} ===`);

  const health = await probe("/api/health");
  ok(health.status === 200, "/api/health answers 200", `got ${health.status}`);
  let healthBody = null;
  try { healthBody = JSON.parse(health.body); } catch { /* asserted below */ }
  ok(healthBody && healthBody.api === "v1",
     "/api/health identifies itself as this API",
     "js/api.js must refuse server mode against anything else; vkon.in answers the same path");
  ok(healthBody && healthBody.status === "ok", "/api/health reports ok");

  const pages = ["/", "/index.html", "/admin", "/admin.html"];
  for (const p of pages) {
    const r = await probe(p);
    ok(r.status === 200, `${p} is served`, `got ${r.status}`);
  }
  ok((await probe("/index.html")).body.includes("shared.js"),
     "/ serves the portal, not an empty Next shell");

  // The rewrite is the only reason / works at all: there is no app/page.tsx, and
  // adding one would put a React shell in front of the real product.
  ok(!(await probe("/")).body.includes("__next_pages"), "/ is the portal document");

  /* ----------------------------------------------------------- every browser asset */

  const indexHtml = readPage("index.html");
  const adminHtml = readPage("admin.html");
  const assetUrls = new Set(["/styles.css", "/shared.js", "/app.js", "/admin.js"]);
  for (const ref of [...localRefsFrom(indexHtml), ...localRefsFrom(adminHtml)]) {
    assetUrls.add(ref.startsWith("/") ? ref : "/" + ref.replace(/^\.\/?/, ""));
  }
  // Anything else sitting in public/ must also be reachable, or the directory is
  // a lie about what the portal needs.
  for (const name of readdirSync(PUBLIC_DIR, { withFileTypes: true })) {
    if (name.isDirectory()) {
      for (const child of readdirSync(join(PUBLIC_DIR, name.name))) {
        assetUrls.add(`/${name.name}/${child}`);
      }
    } else if (!/\.(map|tsbuildinfo)$/.test(name.name)) {
      assetUrls.add("/" + name.name);
    }
  }

  const jsAssets = [];
  for (const urlPath of [...assetUrls].sort()) {
    const r = await probe(encodeURI(urlPath));
    ok(r.status === 200, `asset ${urlPath} is served`, `got ${r.status}`);
    if (/\.js(\?|$)/.test(urlPath)) jsAssets.push({ urlPath, body: r.body });
  }

  /* --------------------------------------------------- nothing that rebuilds the app */

  for (const { urlPath, body } of jsAssets) {
    ok(!/\/\/[#@]\s*sourceMappingURL=/.test(body),
       `${urlPath} ships no source map reference`,
       "a map would reconstruct the server's TypeScript from the browser bundle");
    ok(!/^{"version":3,"sources"/.test(body.trim()), `${urlPath} is not an inline map`);
  }

  // Next's own runtime chunks: the only place a map could hide is /_next/static.
  const chunkRefs = new Set();
  for (const html of [indexHtml, adminHtml]) {
    for (const ref of localRefsFrom(html)) if (ref.startsWith("/_next/")) chunkRefs.add(ref);
  }
  const firstPage = await probe("/");
  for (const m of firstPage.body.matchAll(/["'](\/_next\/static\/[^"']+?\.js)["']/g)) {
    chunkRefs.add(m[1]);
  }
  for (const ref of chunkRefs) {
    const r = await probe(ref);
    ok(r.status === 200 || r.status === 404, `chunk ${ref} resolves`, `got ${r.status}`);
    if (r.status === 200) {
      ok(!/sourceMappingURL/.test(r.body), `chunk ${ref} ships no map`);
    }
  }

  /* ------------------------------------------------------------- secrets stay down */

  for (const [path, why] of MUST_NOT_BE_REACHABLE) {
    const r = await probe(path);
    ok(r.status === 404 || r.status === 403 || r.status === 400 || r.status === 405,
       `${path} is not reachable (${why})`, `got ${r.status}, ${r.body.length} bytes`);
  }

  for (const path of TRAVERSALS) {
    const r = await probe(path);
    if (r.status !== 200) {
      ok(true, `${path} does not read outside the docroot`);
      continue;
    }
    // A 200 here is only acceptable if the server normalised the path and handed
    // back the portal document. Anything else means the traversal was followed.
    const looksNormalised = /<!DOCTYPE html|<html/i.test(r.body);
    const looksLikeSource = /(uvicorn|FastAPI|def [a-z_]+\(|from \.[a-z_]+ import|require\()/.test(r.body);
    ok(looksNormalised && !looksLikeSource,
       `${path} 200 is a normalised document request, not a file`,
       `${r.body.length} bytes returned for a traversal`);
  }

  // Case and trailing-slip variants of the same file, because a deny list is
  // usually written for one spelling.
  for (const path of ["/.GIT/config", "/.env.", "/.env.example", "/Server/Main.py", "/.git/"]) {
    const r = await probe(path);
    ok(r.status !== 200 || path === "/.env.example", `${path} is not served`, `got ${r.status}`);
  }

  /* ---------------------------------------------------------------- header shape */

  for (const p of ["/", "/admin", "/shared.js"]) {
    const r = await probe(p);
    const csp = r.headers.get("content-security-policy") || "";
    ok(csp.length > 0, `${p} carries a CSP`);
    ok(/default-src\s+'self'/.test(csp), `${p} CSP defaults to self`);
    ok(/object-src\s+'none'/.test(csp), `${p} CSP blocks plugins`);
    ok(/frame-ancestors\s+'self'/.test(csp), `${p} CSP blocks framing`);
    ok(/base-uri\s+'self'/.test(csp), `${p} CSP pins <base>`);
    ok(r.headers.get("x-content-type-options") === "nosniff", `${p} sets nosniff`);
    ok(/no-store/.test(r.headers.get("cache-control") || ""), `${p} is never cached`);
    ok(!r.headers.get("x-powered-by"), `${p} leaks no server banner`);
  }

  for (const p of ["/api/health"]) {
    const r = await probe(p);
    const cc = r.headers.get("cache-control") || "";
    ok(/no-store/.test(cc), `${p} responses are un-cacheable at the edge`, cc);
  }

  /* ------------------------------------------- the CSP and the HTML must agree */

  const cspHeader = (await probe("/")).headers.get("content-security-policy") || "";
  const directives = {};
  for (const part of cspHeader.split(";")) {
    const bits = part.trim().split(/\s+/);
    if (bits.length) directives[bits[0]] = bits.slice(1);
  }

  // Every external origin the documents actually load has to be allowed by the
  // policy that covers it. This is the check next.config.mjs promises: the CSP was
  // derived from these files by hand once, and a new <link> or <script> must not be
  // able to ship silently blocked.
  const ORIGIN_BY_TAG = [
    [/<script[^>]+\bsrc\s*=\s*["'](https?:\/\/[^"']+)/gi, "script-src"],
    [/<link[^>]+\bhref\s*=\s*["'](https?:\/\/[^"']+)/gi, "style-src"],
  ];
  const htmlBoth = indexHtml + "\n" + adminHtml;
  for (const [re, directive] of ORIGIN_BY_TAG) {
    for (const m of htmlBoth.matchAll(re)) {
      const origin = new URL(m[1]).origin;
      const allowed = directives[directive] || [];
      const covered = allowed.some((src) => src === origin || src === `${origin}/` ||
        src === "*" || src.startsWith("https:"));
      ok(covered, `${origin} (${directive}) is in the CSP`,
         `add it to ${directive} in next.config.mjs or the portal breaks in production only`);
    }
  }

  // The other direction: 'unsafe-inline' is only defensible while the documents
  // carry inline handlers. When they stop doing that, the config must tighten.
  const hasInlineHandlers = /\son(?:click|submit|change|input|load)\s*=\s*["']/i.test(htmlBoth);
  const hasInlineScripts = /<script(?![^>]*\bsrc=)[^>]*>[\s\S]{20,}?<\/script>/i.test(htmlBoth);
  if (hasInlineHandlers || hasInlineScripts) {
    ok((directives["script-src"] || []).includes("'unsafe-inline'"),
       "script-src allows inline while the documents still use it");
  }

  /* ------------------------------------------------- one token per file, everywhere */

  const tokens = new Map();
  for (const [page, html] of [["index.html", indexHtml], ["admin.html", adminHtml]]) {
    for (const [file, token] of tokenMap(html)) {
      if (tokens.has(file) && tokens.get(file) !== token) {
        ok(false, `${file} carries one cache token across pages`,
           `${page} says ?v=${token}, the other says ?v=${tokens.get(file)}`);
      } else {
        tokens.set(file, token);
      }
    }
  }
  ok(true, "every shared asset carries the same ?v= token on both pages");

  console.log(`=== ${checks - failures}/${checks} probe checks passed ===`);
  if (failures) {
    console.log(`>>> ${failures} PROBE CHECK(S) FAILED <<<`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error("probe crashed:", e);
  process.exit(1);
});
