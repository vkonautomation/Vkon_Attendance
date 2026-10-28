// Test: sign-in routing with a backend present.
//
// The property worth pinning is that a server-backed browser never gets the demo
// answer. If signIn() fell through to demoAuthenticate() while a backend was
// reachable, every hardened password check would be bypassed by the same click that
// used to work in the demo. The second property is that the static build is
// unchanged: with no adapter, behaviour must be exactly the old demo check.
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const code = fs.readFileSync(path.join(__dirname, 'public', 'shared.js'), 'utf8');

let pass = true;
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) pass = false;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
};

// The adapter's own never-synced list, read from the file it is written in. Kept in
// sync by assertion rather than by copy, because a stub that disagrees with the real
// module would make this test prove nothing.
const LOCAL_ONLY = (fs.readFileSync(path.join(__dirname, 'public', 'js', 'api.js'), 'utf8')
  .match(/const LOCAL_ONLY = new Set\(\[([\s\S]*?)\]\)/)[1]
  .match(/"[^"]*"/g) || []).map(s => s.slice(1, -1));
if (!LOCAL_ONLY.length) { console.log('FAIL: could not read LOCAL_ONLY from js/api.js'); process.exit(1); }

// shared.js auto-runs its theme bootstrap as soon as it sees a `window`, so the
// sandbox needs a DOM shallow enough for that path to fall through harmlessly.
const fakeDocument = () => ({
  readyState: "complete",
  documentElement: { setAttribute() {}, classList: { add() {}, remove() {}, toggle() {} } },
  head: { appendChild() {} },
  body: { appendChild() {}, classList: { add() {}, remove() {}, toggle() {} } },
  getElementById: () => null,
  querySelector: () => null,
  querySelectorAll: () => [],
  addEventListener() {},
  createElement: () => ({
    setAttribute() {}, appendChild() {}, addEventListener() {},
    style: {}, classList: { add() {}, remove() {} }, textContent: "",
  }),
});

// Build a fresh shared.js context, optionally with a fake adapter already installed.
function load(responses) {
  const calls = { login: [], write: [], logout: 0, read: [] };
  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    document: fakeDocument(),
    localStorage: {
      _store: {}, getItem(k) { return this._store[k] || null; },
      setItem(k, v) { this._store[k] = v; }, removeItem(k) { delete this._store[k]; },
      key(i) { return Object.keys(this._store)[i] || null; },
      get length() { return Object.keys(this._store).length; }
    }
  };
  const stub = responses ? {
    _calls: calls,
    ready: Promise.resolve(),
    isServerBacked: () => true,
    isProbing: () => false,
    needsPasswordChange: () => !!responses.__needsChange,
    handles: (key) => LOCAL_ONLY.indexOf(key) === -1,
    read(key) { calls.read.push(key); return undefined; },   // no cache: use localStorage
    write(key, val) { calls.write.push(key); },
    login(id, pw) { calls.login.push([id, pw]); return Promise.resolve(responses.login); },
    logout() { calls.logout++; return Promise.resolve(); },
    changePassword(a, b) { return Promise.resolve(responses.change || { ok: true }); },
    onConflict() {}, onRemoteUpdate: null,
  } : null;
  sandbox.window = stub ? { VKON_API: stub } : {};
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  const ctx = vm.runInContext('this', sandbox);
  ctx.__S = vm.runInContext('({ STORAGE_KEYS })', sandbox).STORAGE_KEYS;
  return { ctx, stub, calls, sandbox };
}

const run = async () => {
  // ---- 1. No adapter: the static build behaves exactly as before ----------------
  {
    const { ctx } = load(null);
    check('static build: serverBacked() is false', ctx.serverBacked(), false);
    const r = await ctx.signIn('mukesh', '');
    check('static build: demo check still signs the identity in', r.code, 'employee');
    check('static build: the roster row comes back', r.employee && r.employee.id, 'EMP001');
    const bad = await ctx.signIn('nobody-in-the-roster', 'x');
    check('static build: an unknown identity is still invalid', bad.code, 'invalid');
    ctx.setDemoAuthFlag('off');
    check('static build: the kill switch still closes sign-in',
      (await ctx.signIn('mukesh', '')).code, 'unconfigured');
  }

  // ---- 2. Server present: the server's answer is the only answer ----------------
  {
    const { ctx, calls } = load({ login: { code: 'invalid', message: 'Incorrect username or password.' } });
    check('server build: serverBacked() is true', ctx.serverBacked(), true);
    const r = await ctx.signIn('mukesh', 'wrong-once-too-often');
    // 'mukesh' exists in the roster, so the demo check would have said "employee".
    // Getting "invalid" is the proof that the demo path was not taken.
    check('server build: the server\'s refusal wins over the demo check', r.code, 'invalid');
    check('server build: the credential was sent to the server once', calls.login.length, 1);
    check('server build: what was sent is the typed identifier', calls.login[0][0], 'mukesh');
    check('server build: what was sent is the typed password', calls.login[0][1], 'wrong-once-too-often');
  }

  // ---- 3. Server-backed outcomes -----------------------------------------------
  {
    const emp = load({ login: { code: 'employee', session: { employeeId: 'EMP001', role: 'employee', username: 'mukesh' } } });
    const r = await emp.ctx.signIn('mukesh', 'pw');
    check('employee: resolved through the server session', r.code, 'employee');
    check('employee: the roster row is attached for the existing UI', r.employee && r.employee.id, 'EMP001');

    const adm = load({ login: { code: 'admin', session: { role: 'admin', username: 'admin', name: 'VKON Administrator' } } });
    const ra = await adm.ctx.signIn('admin', 'pw');
    check('admin: role comes from the session, not the typed name', ra.code, 'admin');
    check('admin: the session is handed to the caller', ra.session.username, 'admin');

    const ghost = load({ login: { code: 'employee', session: { employeeId: 'EMP999', role: 'employee' } } });
    check('an account with no roster row is refused, not silently let in',
      (await ghost.ctx.signIn('stranger', 'pw')).code, 'noRoster');

    const first = load({ login: { code: 'passwordChange', session: { username: 'mukesh', mustChangePassword: true } } });
    check('a first sign-in is reported as a forced password change',
      (await first.ctx.signIn('mukesh', 'temp')).code, 'passwordChange');

    const throttled = load({ login: { code: 'throttled', message: 'Too many attempts. Try again in 40 seconds.' } });
    check('rate limiting is passed through with its own message',
      (await throttled.ctx.signIn('mukesh', 'x')).code, 'throttled');

    const down = load({ login: { code: 'unreachable', message: 'Request failed (0)' } });
    check('an unreachable server is its own outcome, not "invalid"',
      (await down.ctx.signIn('mukesh', 'x')).code, 'unreachable');
  }

  // ---- 4. Store reads and writes go through the adapter -------------------------
  {
    const { ctx, calls, sandbox } = load({ login: { code: 'invalid' } });
    ctx.setStore(ctx.__S.RECORDS, { 'EMP001_2026-10-27': { status: 'Present' } });
    check('a shared store is still mirrored to localStorage',
      !!sandbox.localStorage.getItem(ctx.__S.RECORDS), true);
    check('a shared store is offered to the server', calls.write, [ctx.__S.RECORDS]);

    ctx.setStore(ctx.__S.CURRENT_SESSION, { role: 'admin' });
    check('the session store is never published (it is per-browser)', calls.write, [ctx.__S.RECORDS]);

    // signOut must end the server session as well as the local one.
    await ctx.signOut();
    check('signOut() ends the server session too', calls.logout, 1);
  }

  {
    const noAdapter = load(null);
    await noAdapter.ctx.signOut();
    check('signOut() on a static host touches no server', noAdapter.calls.logout, 0);
  }

  console.log(pass ? '\n>>> SIGN-IN ROUTING OK <<<\n' : '\n>>> FAILURES <<<\n');
  process.exit(pass ? 0 : 1);
};

run().catch((e) => { console.error('Test harness error:', e); process.exit(1); });
