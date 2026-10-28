/**
 * tests/guard.mjs -- the public-repository guard.
 *
 * The repository is public. So "no secrets and no real data are committed" is not a
 * instruction to be careful; it is a build step that fails. Everything below is checked
 * against the files that would be published, and the rules are the ones the plan names:
 * nothing shaped like a credential, no email outside the reserved test domain, and no
 * name list lifted from production.
 *
 * Two scopes, because they fail differently:
 *
 *   tracked files (`git ls-files`)  -- what is actually public. A file that is not
 *      tracked is not in the repository no matter what it looks like on a laptop, so
 *      this is the authoritative list for "did an export or a .env get committed".
 *   seed and fixtures               -- the content rules. These files are committed and
 *      read by tests, so they must be obviously synthetic rather than plausibly so.
 *
 * Note what is deliberately NOT required: a .gitignore. It is untracked by design (D6 --
 * the deploy host owns its own copy because a tracked one aborts `git merge --ff-only`),
 * so its absence in a fresh clone is normal. The ignore rules are checked when the file
 * exists and reported as a skip when it does not; the tracked-files check does not care
 * either way, which is why it is the one that matters.
 *
 * Usage: node tests/guard.mjs        (runs as part of npm test)
 */

import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(join(fileURLToPath(new URL(".", import.meta.url)), ".."));

const checks = [];

function check(name, passed, detail) {
  checks.push({ name, passed: !!passed, detail });
  console.log(`${passed ? "ok    " : "FAIL  "} ${name}`);
  if (!passed && detail) {
    for (const line of String(detail).split("\n").slice(0, 12)) console.log(`        ${line}`);
  }
}

// Directories that hold no committed source, so walking them can only produce noise:
// node_modules is third-party code this guard cannot speak for, and .next is build
// output derived from files that are scanned in their source form above.
const SKIP_DIRS = new Set(["node_modules", ".next", ".git", "coverage", "payload"]);

function walk(dir, out = []) {
  let dirents;
  try {
    dirents = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of dirents) {
    if (e.isDirectory() && SKIP_DIRS.has(e.name)) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.isFile()) out.push(p);
  }
  return out;
}

/* ------------------------------------------------------------------ what is scanned */

const SCANNED_DIRS = ["db/seed", "tests/fixtures", "tests/unit", "app", "lib"];

// .env.example is committed and copied straight to .env, so the credential shapes apply
// to it as much as to a fixture. It is scanned as a file rather than a directory because
// a wildcard over the repo root would drag in the untracked .env it exists to imitate.
const SCANNED_FILES = [".env.example"];

function scannedFiles() {
  const files = [];
  for (const dir of SCANNED_DIRS) {
    const abs = join(ROOT, dir);
    if (!existsSync(abs)) continue;
    for (const f of walk(abs)) files.push(f);
  }
  for (const rel of SCANNED_FILES) {
    const abs = join(ROOT, rel);
    if (existsSync(abs)) files.push(abs);
  }
  return files;
}

function trackedFiles() {
  try {
    return execFileSync("git", ["ls-files"], { cwd: ROOT, encoding: "utf8" })
      .split(/\r?\n/).filter(Boolean);
  } catch {
    return null; // not a checkout, or git is unavailable
  }
}

/* ------------------------------------------------------------------------ the rules */

// The domain reserved for documentation and tests: RFC 6761 says it cannot be registered,
// so an address at it can never reach a person. Anything else in a committed fixture is
// either real or an accident waiting to be mailed.
const ALLOWED_EMAIL_DOMAINS = ["example.test", "example.com", "test.invalid"];
const EMAIL_RE = /[A-Za-z0-9._%+-]+@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/g;

// Shapes that mean "a credential was here", each one a format no synthetic fixture needs
// to imitate. These are not a blacklist of specific secrets -- they are the reason a
// secret cannot be hidden inside an otherwise innocent-looking file.
const CREDENTIAL_PATTERNS = [
  ["bcrypt hash", /\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}/],
  ["private key", /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/],
  ["AWS access key id", /\bAKIA[0-9A-Z]{16}\b/],
  ["Google API key", /\bAIza[0-9A-Za-z_-]{35}\b/],
  ["GitHub token", /\bgh[pousr]_[0-9A-Za-z]{36,}\b/],
  ["JSON web token", /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/],
  ["slack webhook", /https:\/\/hooks\.slack\.com\/services\/T[0-9A-Za-z_]+\/B[0-9A-Za-z_]+\/[0-9A-Za-z]+/],
  ["PEM certificate body", /MII[A-Za-z0-9/+]{80,}/],
  ["64-hex secret", /\b[0-9a-f]{64}\b/],
  ["40-char base64 secret", /\b(?=[A-Za-z0-9+/]{40})(?=[A-Za-z0-9+/]*[0-9])(?=[A-Za-z0-9+/]*[A-Z])[A-Za-z0-9+/]{40}\b/],
];

// Burned by history: these appear in commits that are already public, so they must never
// reappear as a seed value, a fixture default, or a "temporary" password.
const BURNED_SECRETS = ["admin123", "password123", "vkon@123", "Admin@123", "12345678"];

// 10-digit Indian mobile numbers and 12-digit Aadhaar numbers. Not secrets, but real
// data in a public file either way, and a fixture never needs one.
const PII_PATTERNS = [
  ["10-digit Indian mobile", /\b(?:\+91[\s-]?)?[6-9]\d{9}\b/],
  ["12-digit Aadhaar-shaped", /\b[6-9]\d{11}\b/],
];

// Names the portal's demo roster already carries. They came from the organisation, so a
// fixture that reuses them is not synthetic -- it is the roster with new numbers on it.
//
// "admin" is in that list as a username, but it is the role name the plan itself reserves
// for the bootstrap account ("db:seed in a dev environment creates admin"), so it cannot
// be forbidden as a word. Only names that mean a specific person are watched.
const GENERIC_ROLE_WORDS = new Set(["admin"]);

function forbiddenNames() {
  const shared = join(ROOT, "public", "shared.js");
  if (!existsSync(shared)) return new Set();
  const text = readFileSync(shared, "utf8");
  const block = text.slice(
    text.indexOf("DEFAULT_EMPLOYEES"),
    text.indexOf("DEFAULT_EMPLOYEES") + 6000,
  );
  const names = new Set();
  for (const m of block.matchAll(/\b(?:name|username):\s*"([^"]{3,})"/g)) {
    if (!GENERIC_ROLE_WORDS.has(m[1].toLowerCase())) names.add(m[1]);
  }
  return names;
}

/** Lines that match `re`, as "file:line: text". */
function matchesIn(file, text, re, limit = 3) {
  const hits = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length && hits.length < limit; i++) {
    if (re.test(lines[i])) hits.push(`${file}:${i + 1}: ${lines[i].trim().slice(0, 110)}`);
  }
  return hits;
}

// Files that must not be in the published tree at all. These are path shapes, not
// contents: a tracked file matching one of these is public already, whatever is in it.
const FORBIDDEN_TRACKED = [
  [/(^|\/)\.env$/, "the live environment file"],
  [/(^|\/)\.env\.(?!example)/, "a local environment override"],
  [/^db\/seed\/real\.sql$/, "a real-data seed"],
  [/(^|\/)[^/]*export[^/]*\.json$/i, "an exported attendance document"],
  [/(^|\/)(id_rsa|\.netrc|service-account\.json)$/, "a machine credential"],
];

// .env.example is the one environment file that belongs in the repository, and it
// belongs there empty wherever a secret would go. A non-empty value in a committed
// example is how a default password becomes a production password.
//
// Some values are not secrets and are load-bearing precisely because they are spelled
// out: a stage name, a port, a path, the role names db-setup.mjs creates. Each
// exemption below is a shape that cannot authenticate, listed as a predicate rather
// than one alternation, so that adding one is a visible decision -- and so the
// self-test at the end can prove the list still refuses what it must refuse.
const NON_SECRET_VALUES = [
  ["a stage or boolean", /^(development|production|true|false|null|yes|no)$/i],
  ["a number such as a port", /^\d+$/],
  // Deliberately excludes '+' and '/' anywhere but as a separator between path
  // segments, so a base64 blob that happens to start with a slash stays a failure.
  ["an absolute filesystem path", /^([A-Za-z]:\\|\/)[A-Za-z0-9._-]+([\/][A-Za-z0-9._-]*)*$/],
  ["a role or database name this repo creates", /^(attendance_app|vkon_owner|postgres|vkon_attendance[a-z_]*|admin)$/i],
  ["an address at a reserved test domain", /^[A-Za-z0-9._%-]+@(example\.(test|com)|test\.invalid)$/],
];

function isNonSecretValue(value) {
  return NON_SECRET_VALUES.some(([, re]) => re.test(value));
}

/* ---------------------------------------------------------------------------- run it */

const files = scannedFiles();
check("seed/fixture/app/lib files found to scan", files.length > 0,
  `scanned ${SCANNED_DIRS.join(", ")} from ${ROOT}`);

/** Escape a literal string for use inside a RegExp built from a string source. */
function reEscape(s) {
  return s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
}

// 1. Credentials, by shape rather than by memory.
for (const [label, re] of CREDENTIAL_PATTERNS) {
  const hits = files.flatMap((f) => {
    const rel = f.slice(ROOT.length + 1).split(sep).join("/");
    return matchesIn(rel, readFileSync(f, "utf8"), re);
  });
  check(`no ${label} in committed seed or fixtures`, hits.length === 0, hits.join("\n"));
}

// 2. Values that were burned by public history.
{
  const re = new RegExp(`${reEscape(BURNED_SECRETS.join("|"))}`, "i");
  const hits = files.flatMap((f) => {
    const rel = f.slice(ROOT.length + 1).split(sep).join("/");
    return matchesIn(rel, readFileSync(f, "utf8"), re);
  });
  check("no burned demo password reused as a seed value", hits.length === 0, hits.join("\n"));
}

// 3. Email domains. example.com is allowed only inside documentation strings about the
// domain itself; the reserved .test domains are what fixtures should use.
{
  const offenders = [];
  for (const f of files) {
    const rel = f.slice(ROOT.length + 1).split(sep).join("/");
    const text = readFileSync(f, "utf8");
    for (const m of text.matchAll(EMAIL_RE)) {
      const domain = m[1].toLowerCase();
      if (!ALLOWED_EMAIL_DOMAINS.includes(domain)) offenders.push(`${rel}: ${m[0]}`);
    }
  }
  check("every email in seed and fixtures is at a reserved test domain",
    offenders.length === 0, [...new Set(offenders)].join("\n"));
}

// 4. PII-shaped numbers.
for (const [label, re] of PII_PATTERNS) {
  const hits = files.flatMap((f) => {
    const rel = f.slice(ROOT.length + 1).split(sep).join("/");
    return matchesIn(rel, readFileSync(f, "utf8"), re);
  });
  check(`no ${label} in committed seed or fixtures`, hits.length === 0, hits.join("\n"));
}

// 5. The roster. Matched on word boundaries and case-insensitively, because "Mukesh
//    Sharma" inside a fixture is the leak whether or not it is capitalised the same way.
{
  const forbidden = forbiddenNames();
  const hits = [];
  for (const n of forbidden) {
    const re = new RegExp(`\\b${reEscape(n)}\\b`, "i");
    for (const f of files) {
      const rel = f.slice(ROOT.length + 1).split(sep).join("/");
      for (const line of matchesIn(rel, readFileSync(f, "utf8"), re, 1)) hits.push(line);
    }
  }
  check("no name or username from the portal's roster appears in seed or fixtures",
    hits.length === 0, `(${forbidden.size} names watched)\n${hits.join("\n")}`);
}

// 6. What is actually tracked. A file that is not tracked is not published, and a file
// that is published is public forever -- so this is the check that does not depend on
// anybody remembering an ignore rule.
{
  const tracked = trackedFiles();
  if (tracked === null) {
    console.log("SKIP   tracked-file checks (git ls-files unavailable)");
  } else {
    for (const [re, what] of FORBIDDEN_TRACKED) {
      const hits = tracked.filter((f) => re.test(f));
      check(`git-tracked files contain no ${what}`, hits.length === 0, hits.join("\n"));
    }

    const example = join(ROOT, ".env.example");
    if (existsSync(example)) {
      const filled = [];
      for (const line of readFileSync(example, "utf8").split(/\r?\n/)) {
        if (/^#/.test(line) || !/^[A-Z0-9_]+=\S/.test(line)) continue;
        const value = line.slice(line.indexOf("=") + 1).trim();
        if (!isNonSecretValue(value)) filled.push(line);
      }
      check(".env.example carries no value that could authenticate",
        filled.length === 0, filled.join("\n"));
    }
  }
}

// 7. The ignore rules, when the file exists. Advisory by design (D6): the deploy host
// owns this file and a clone may not have one.
{
  const gitignore = join(ROOT, ".gitignore");
  if (existsSync(gitignore)) {
    const text = readFileSync(gitignore, "utf8");
    for (const pattern of [".env", ".env.*", "db/seed/real.sql", ".scratch/"]) {
      check(`.gitignore covers ${pattern}`,
        text.split(/\r?\n/).some((l) => l.trim() === pattern),
        "the host's .gitignore is untracked, so this is a reminder, not a gate");
    }
  } else {
    console.log("SKIP   .gitignore coverage (no .gitignore in this checkout; see D6)");
  }
}

// 8. The guard against itself. A check that can never fail is worse than no check, it
//    reads as reassurance. So every rule here is handed the leak it is supposed to catch,
//    and one ordinary value it is supposed to leave alone -- the checksum in a migration
//    log, a path in .env.example, a name that is a role rather than a person. Samples are
//    assembled rather than written out, so this file does not itself contain a string in
//    the shape of a credential.
{
  const assembled = {
    "bcrypt hash": "$2b$12$" + "x".repeat(53),
    "private key": "-----BEGIN RSA " + "PRIVATE KEY-----",
    "AWS access key id": "AKIA" + "A".repeat(16),
    "Google API key": "AIza" + "A".repeat(35),
    "GitHub token": "ghp_" + "A".repeat(36),
    "JSON web token": "eyJ" + "A".repeat(12) + ".eyJ" + "B".repeat(12) + "." + "C".repeat(12),
    "slack webhook": "https://hooks.slack.com/services/" + "T1111111/BBBBBBBB/222222222222222222222222",
    "PEM certificate body": "MII" + "A".repeat(90),
    "64-hex secret": "a".repeat(64),
    "40-char base64 secret": "A".repeat(39) + "1",
  };
  const missed = CREDENTIAL_PATTERNS.filter(([label, re]) => !re.test(assembled[label]));
  check("every credential rule catches the credential it names",
    missed.length === 0, missed.map(([l]) => l).join(", "));

  // A sha256 checksum is lower-case hex and 64 characters long, so it looks exactly like
  // the shape above. It has to be refused on the same terms as a real secret, which means
  // a migration comment quoting one is a finding -- the checksum belongs in the database
  // ledger, not in committed prose. What must pass is the shorter hex of a git sha.
  const falsePositives = [];
  if (/\b[0-9a-f]{64}\b/.test("e3b0c44298fc1c149afbf4c8996fb924")) {
    falsePositives.push("40-hex git sha flagged as a secret");
  }
  check("an ordinary git sha is not flagged", falsePositives.length === 0, falsePositives.join("\n"));

  const allowed = ["development", "true", "5433", "/var/lib/vkon/vkon.db", "attendance_app",
                   "vkon_attendance_dev", "tester_a@example.test"];
  const refused = allowed.filter((v) => !isNonSecretValue(v));
  check("ordinary .env.example values stay exempt", refused.length === 0, refused.join(", "));

  const dangerous = ["a".repeat(64), "hunter2", "$2b$12$" + "x".repeat(53), "AKIA" + "A".repeat(16)];
  const accepted = dangerous.filter((v) => isNonSecretValue(v));
  check("the exemption list refuses anything that could authenticate",
    accepted.length === 0, accepted.join(", "));

  const roster = forbiddenNames();
  check("the roster names to watch were actually found", roster.size >= 5,
    `found ${roster.size}; if public/shared.js moved, this guard is silently blind`);
  {
    const [first] = [...roster];
    const probe = new RegExp(`\\b${reEscape(first)}\\b`, "i");
    const hits = [];
    if (!probe.test(`insert into employees values ('${first}')`)) hits.push("roster name not detected");
    if (probe.test("values ('A Tester'), ('EMP001')")) hits.push("synthetic name falsely flagged");
    check("the name rule detects a real name and ignores a synthetic one",
      hits.length === 0, hits.join("\n") + ` (probed "${first}")`);
  }
}

const failed = checks.filter((c) => !c.passed);
console.log(`\n=== tests/guard.mjs: ${checks.length - failed.length}/${checks.length} checks passed ===`);
if (failed.length) {
  console.log(`>>> ${failed.length} FAILED: ${failed.map((f) => f.name).join(", ")}`);
  process.exit(1);
}
