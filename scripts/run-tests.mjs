/**
 * scripts/run-tests.mjs -- the whole suite, in one command.
 *
 * The rule this exists to enforce: a milestone is only done when the portal still
 * works. That means the public-repository guard, the unit tests, the 11 Node rule
 * suites (which load public/shared.js for real inside a shim), the Python
 * source-and-backend verifiers, the database integration suite, and the HTTP probe run
 * against the assembled standalone payload -- the same directory the image ships and
 * the only arrangement in which "nothing outside public/ is reachable" is a claim that
 * can actually be tested.
 *
 * Nothing here is a framework. Each suite is a file that exits non-zero when it
 * fails, which is the only contract a runner needs.
 *
 * Order is deliberate: the guard runs first because it is the only check whose failure
 * means something has already been published. Everything after it can wait.
 *
 * Usage:  node scripts/run-tests.mjs [--no-serve]   (--no-serve skips the probe)
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SKIP_SERVE = process.argv.includes("--no-serve");
const PORT = Number(process.env.TEST_PORT || 3210);
const BASE = `http://127.0.0.1:${PORT}`;

const results = [];

function record(name, code, tail) {
  const passed = code === 0;
  results.push({ name, passed });
  console.log(`${passed ? "ok   " : "FAIL "} ${name}`);
  if (!passed && tail) console.log(tail.split("\n").slice(-25).map((l) => `     ${l}`).join("\n"));
}

function run(label, cmd, args, opts) {
  const r = spawnSync(cmd, args, Object.assign({ cwd: ROOT, encoding: "utf8" }, opts || {}));
  const tail = `${r.stdout || ""}${r.stderr || ""}`;
  record(label, r.status === null ? 1 : r.status, tail);
}

function pythonExe() {
  const venv = join(ROOT, ".venv", "Scripts", "python.exe");
  if (existsSync(venv)) return venv;
  const unix = join(ROOT, ".venv", "bin", "python");
  if (existsSync(unix)) return unix;
  return process.platform === "win32" ? "py" : "python3";
}

/* ------------------------------------------------------------- the public-repo guard */

console.log("\n=== public repository guard ===");
run("tests/guard.mjs", process.execPath, [join(ROOT, "tests", "guard.mjs")]);

/* ------------------------------------------------------------------- unit suites */

const unitDir = join(ROOT, "tests", "unit");
const unitSuites = existsSync(unitDir)
  ? readdirSync(unitDir).filter((f) => f.endsWith(".mjs")).sort()
  : [];
console.log(`\n=== ${unitSuites.length} unit suites ===`);
for (const f of unitSuites) run(`tests/unit/${f}`, process.execPath, [join(unitDir, f)]);

/* ------------------------------------------------------------------ node rule suites */

const jsSuites = readdirSync(ROOT).filter((f) => /^test_.*\.js$/.test(f)).sort();
console.log(`\n=== ${jsSuites.length} Node suites ===`);
for (const f of jsSuites) run(`node ${f}`, process.execPath, [f]);

/* ------------------------------------------------------------------- python suites */

const py = pythonExe();
const verifiers = readdirSync(ROOT).filter((f) => /^verify_.*\.py$/.test(f)).sort();
console.log(`\n=== ${verifiers.length} Python verifiers ===`);
for (const f of verifiers) run(`python ${f}`, py, [f]);

console.log("\n=== pytest ===");
run("pytest", py, ["-m", "pytest", "-q"]);

/* ------------------------------------------------------------- database integration */

// The database suite skips itself, loudly, when no Postgres is reachable -- see the
// header of tests/integration/db.mjs for why a skip has to be visible rather than
// green. REQUIRE_DB=1 turns that skip into a failure for a machine that is meant to
// have one.
console.log("\n=== database integration ===");
run("tests/integration/db.mjs", process.execPath, [join(ROOT, "tests", "integration", "db.mjs")]);

/* ------------------------------------------------- typecheck, then the live probe */

console.log("\n=== typecheck ===");
run("tsc --noEmit", process.execPath,
    [join(ROOT, "node_modules", "typescript", "bin", "tsc"), "--noEmit"]);

if (SKIP_SERVE) {
  console.log("\n=== probe skipped (--no-serve) ===");
} else {
  console.log("\n=== build ===");
  const build = spawnSync(process.execPath,
    [join(ROOT, "node_modules", "next", "dist", "bin", "next"), "build"],
    { cwd: ROOT, encoding: "utf8" });
  record("next build", build.status === null ? 1 : build.status,
         `${build.stdout || ""}${build.stderr || ""}`);

  if (results.some((r) => !r.passed)) {
    console.log("\n>>> not probing: the build or a suite already failed <<<");
  } else {
    console.log(`\n=== serving the standalone payload on ${BASE} ===`);
    const server = spawn(process.execPath, [join(ROOT, "scripts", "start-standalone.mjs")], {
      cwd: ROOT,
      env: Object.assign({}, process.env, { BIND_HOST: "127.0.0.1", PORT: String(PORT) }),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let serverLog = "";
    server.stdout.on("data", (d) => { serverLog += d; });
    server.stderr.on("data", (d) => { serverLog += d; });
    server.on("error", (e) => { serverLog += `\n${e.message}`; });

    let up = false;
    for (let i = 0; i < 60 && !up; i++) {
      try {
        const r = await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(1500) });
        up = r.ok;
      } catch {
        await new Promise((r) => setTimeout(r, 400));
      }
    }

    if (!up) {
      record("server started", 1, serverLog);
    } else {
      record("server started", 0);
      const probe = spawnSync(process.execPath, [join(ROOT, "tests", "probe.mjs")], {
        cwd: ROOT, encoding: "utf8", env: Object.assign({}, process.env, { PROBE_BASE_URL: BASE }),
      });
      record("tests/probe.mjs", probe.status === null ? 1 : probe.status,
             `${probe.stdout || ""}${probe.stderr || ""}`);
      // Whatever the probe said about the wire is what the payload really served.
      console.log("     --- server log ---");
      for (const line of serverLog.trim().split("\n").slice(-12)) console.log(`     ${line}`);
    }
    server.kill();
  }
}

/* ------------------------------------------------------------------------- verdict */

const failed = results.filter((r) => !r.passed);
console.log(`\n=== ${results.length - failed.length}/${results.length} suites passed ===`);
if (failed.length) {
  console.log(`>>> ${failed.length} FAILED: ${failed.map((f) => f.name).join(", ")}`);
  process.exit(1);
}
