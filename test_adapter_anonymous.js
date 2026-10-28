/**
 * The adapter must not try to publish anything before a session exists.
 *
 * Why this file exists: with the backend running, the untouched login screen issued
 * 650+ PUT /api/state/* requests in three minutes. handles() treated "a server
 * answered /api/health" as "this browser may write to it", so shared.js seeding its
 * demo defaults pushed every store at the server; each 401 was classed as a dropped
 * network error, which re-dirtied the store and scheduled the next attempt. A tight
 * loop that is also an attempt to overwrite the company roster with an anonymous
 * visitor's local copy.
 *
 * Run: node test_adapter_anonymous.js
 */
const fs = require("fs");
const vm = require("vm");
const path = require("path");

const SRC = fs.readFileSync(path.join(__dirname, "public", "js", "api.js"), "utf8");

let fails = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fails++;
  console.log(`${ok ? "PASS" : "FAIL"}: ${name}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
}

// fetch calls are counted per method+path, so "did it loop" is a number rather than
// a judgement call.
function makeFetch(handler) {
  const calls = [];
  return {
    calls,
    fn: (url, opts) => {
      const method = (opts && opts.method) || "GET";
      calls.push(`${method} ${url}`);
      const res = handler(url, opts, calls.length);
      return Promise.resolve({
        ok: res.status >= 200 && res.status < 300,
        status: res.status,
        text: () => Promise.resolve(typeof res.body === "string" ? res.body : JSON.stringify(res.body)),
      });
    },
  };
}

function makeLocalStorage() {
  const map = new Map();
  return {
    get length() { return map.size; },
    key: (i) => Array.from(map.keys())[i] ?? null,
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    _map: map,
  };
}

function build(handler) {
  const timers = [];
  // The delays actually handed to setTimeout. A fake clock that fires every pending
  // timer on command cannot show backoff by counting attempts - all it shows is how
  // many were scheduled - so the growth of the delay is what gets asserted.
  const delays = [];
  const fetcher = makeFetch(handler);
  const win = {
    addEventListener: () => {},
    crypto: { randomUUID: () => "12345678-1234-1234-1234-123456789abc" },
  };
  const sandbox = {
    window: win,
    document: { addEventListener: () => {}, hidden: false },
    localStorage: makeLocalStorage(),
    fetch: fetcher.fn,
    setInterval: () => 0,           // pull() must not fire during a synchronous test
    setTimeout: (fn, delay) => { timers.push(fn); delays.push(delay || 0); return timers.length; },
    clearTimeout: () => {},
    console,
    crypto: win.crypto,             // api.js reaches it as a bare global too
    JSON, Math, Date, Object, Array, Set, Error, Promise, String, Number, RegExp,
    TypeError, encodeURIComponent, decodeURIComponent, parseInt, parseFloat, isNaN,
  };
  sandbox.win = win;
  win.VKON_API = undefined;
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox);
  const api = win.VKON_API;
  return {
    api,
    fetcher,
    delays,
    // Pending flush callbacks, run one at a time so a loop is visible as growth.
    runTimers: () => { const t = timers.splice(0); t.forEach((fn) => fn()); return t.length; },
  };
}

const drain = () => new Promise((r) => setImmediate(r));

(async () => {
  // ---------------------------------------------------------------- anonymous
  const anon = build((url) => {
    if (url === "/api/health") return { status: 200, body: { status: "ok" } };
    if (url === "/api/auth/me") return { status: 200, body: { signedIn: false } };
    if (url.startsWith("/api/state")) return { status: 401, body: { error: { message: "Sign in first." } } };
    return { status: 404, body: {} };
  });
  await anon.api.ready;
  await drain();

  check("an anonymous visitor still knows a server is there", anon.api.isServerBacked(), true);
  check("but no store is offered for writing", anon.api.handles("vkon_records_v6"), false);
  check("the session store is still local-only", anon.api.handles("vkon_session_v6"), false);

  // Even if a caller forces a write, nothing must leave the device.
  anon.api.write("vkon_records_v6", [{ employeeId: "EMP001" }]);
  for (let round = 0; round < 5; round++) { anon.runTimers(); await drain(); await drain(); }
  const puts = anon.fetcher.calls.filter((c) => c.startsWith("PUT"));
  check("a forced write while anonymous issues no request", puts, []);

  // --------------------------------------------------------------- after login
  const user = build((url, opts, n) => {
    if (url === "/api/health") return { status: 200, body: { status: "ok" } };
    if (url === "/api/auth/me") return { status: 200, body: { signedIn: false } };
    if (url === "/api/auth/login") {
      return { status: 200, body: { role: "employee", employeeId: "EMP001", mustChangePassword: false } };
    }
    if (url === "/api/state") return { status: 200, body: { serverVersion: 3, stores: {} } };
    if (url.startsWith("/api/state/")) return { status: 200, body: { version: 4 } };
    return { status: 404, body: {} };
  });
  await user.api.ready;
  await drain();
  const loggedIn = await user.api.login("mukesh", "whatever");
  await drain();
  check("sign-in succeeds", loggedIn.code, "employee");
  check("and the write path opens", user.api.handles("vkon_records_v6"), true);

  user.api.write("vkon_records_v6", [{ employeeId: "EMP001" }]);
  user.runTimers(); await drain(); await drain();
  check("a write while signed in does reach the server",
        user.fetcher.calls.some((c) => c === "PUT /api/state/vkon_records_v6"), true);

  // ------------------------------------------------- session lost mid-edit (401)
  const lost = build((url) => {
    if (url === "/api/health") return { status: 200, body: { status: "ok" } };
    if (url === "/api/auth/me") return { status: 200, body: { signedIn: false } };
    if (url === "/api/auth/login") {
      return { status: 200, body: { role: "employee", employeeId: "EMP001", mustChangePassword: false } };
    }
    if (url === "/api/state") return { status: 200, body: { serverVersion: 1, stores: {} } };
    if (url.startsWith("/api/state/")) return { status: 401, body: { error: { message: "Sign in first." } } };
    return { status: 404, body: {} };
  });
  await lost.api.ready;
  await drain();
  await lost.api.login("mukesh", "whatever");
  await drain();

  let notified = 0;
  lost.api.onConflict(() => { notified++; });
  lost.api.write("vkon_records_v6", [{ employeeId: "EMP001" }]);

  // Twenty rounds of the timer that used to re-arm itself.
  for (let round = 0; round < 20; round++) { lost.runTimers(); await drain(); await drain(); }
  const lostPuts = lost.fetcher.calls.filter((c) => c.startsWith("PUT")).length;
  check("a 401 stops retrying instead of re-dirtying forever", lostPuts <= 2, true);
  check("the write path closes when the session is refused",
        lost.api.handles("vkon_records_v6"), false);
  check("the person is told once, not on every attempt", notified <= 2, true);

  // ------------------------------------------------------------ backoff growth
  const offline = build((url) => {
    if (url === "/api/health") return { status: 200, body: { status: "ok" } };
    if (url === "/api/auth/me") return { status: 200, body: { signedIn: false } };
    if (url === "/api/auth/login") {
      return { status: 200, body: { role: "employee", employeeId: "EMP001", mustChangePassword: false } };
    }
    if (url === "/api/state") return { status: 200, body: { serverVersion: 1, stores: {} } };
    throw new Error("network down");
  });
  await offline.api.ready;
  await drain();
  await offline.api.login("mukesh", "whatever");
  await drain();
  offline.api.write("vkon_records_v6", [{ employeeId: "EMP001" }]);
  for (let round = 0; round < 30; round++) { offline.runTimers(); await drain(); await drain(); }
  check("a genuinely dropped connection keeps the edit queued",
        offline.api.handles("vkon_records_v6"), true);
  const scheduled = offline.delays.filter((d) => d > 0);
  check("every retry is scheduled, not fired immediately", scheduled.length > 3, true);
  check("and the wait grows instead of staying at one second",
        scheduled[scheduled.length - 1] > scheduled[0], true);
  check("without ever exceeding the cap", Math.max(...scheduled) <= 30000, true);

  // ------------------------------------------- the forced first change payload
  // js/password-change.js hides the current-password field on a first login, because
  // the one-time password is already sitting in the sign-in box. api.js used to send
  // an empty string for it, the request schema required a non-empty one, and every
  // real-browser change died with a 422 - invisible to any test that cheerfully
  // supplied the password the user was never asked to type.
  const bodies = [];
  const pw = build((url, opts) => {
    if (url === "/api/health") return { status: 200, body: { status: "ok" } };
    if (url === "/api/auth/me") return { status: 200, body: { signedIn: false } };
    if (url === "/api/auth/login") {
      return { status: 200, body: { role: "employee", employeeId: "EMP002", mustChangePassword: true } };
    }
    if (url === "/api/auth/password") {
      bodies.push(JSON.parse(opts.body));
      return { status: 200, body: { ok: true } };
    }
    if (url === "/api/state") return { status: 200, body: { serverVersion: 1, stores: {} } };
    return { status: 404, body: {} };
  });
  await pw.api.ready;
  await drain();
  await pw.api.login("priya", "one-time");
  await drain();

  const forced = await pw.api.changePassword("", "Priya-Long-Pass-4");
  await drain();
  check("the forced change goes through", forced.ok, true);
  check("without an empty current-password on the wire",
        bodies.length > 0 && !("currentPassword" in bodies[0]), true);
  check("carrying the chosen password instead", bodies[0].newPassword, "Priya-Long-Pass-4");

  await pw.api.changePassword("Priya-Long-Pass-4", "Priya-Another-Pass-9");
  await drain();
  check("a later change does prove the old password", bodies[1].currentPassword, "Priya-Long-Pass-4");

  console.log(fails ? `\n>>> ${fails} ADAPTER ASSERTION(S) FAILED <<<` : "\n>>> ADAPTER AUTH GATE OK <<<");
  process.exit(fails ? 1 : 0);
})();
