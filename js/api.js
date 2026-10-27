/**
 * VKON server adapter.
 *
 * Loaded before shared.js. Its job is to let a 22,000-line front end written
 * against a synchronous localStorage API keep working untouched: getStore() reads
 * an in-memory cache that this module hydrates, and setStore() updates that cache
 * immediately and pushes to the server a moment later.
 *
 * Three rules hold it together:
 *
 *  1. localStorage is never bypassed. Every write still lands there, so the page
 *     works with the network unplugged, on a train, or with the backend stopped,
 *     and falls back to exactly the old behaviour with no data loss.
 *  2. The server is authoritative only for what it can actually arbitrate:
 *     identity, the punch record, and who may change which store. Day arithmetic
 *     stays in shared.js, which is already tested to death.
 *  3. A write that conflicts is adopted, not overwritten. If a colleague changed
 *     the same store first, their version wins and this tab is told, because a
 *     silent last-writer-wins is how approval workflows lose decisions.
 */
window.VKON_API = (function () {
  "use strict";

  const BASE = "/api";
  const FLUSH_DEBOUNCE_MS = 1200;
  // A tab left open should notice an approval without a reload. One small request
  // a minute is nothing on a rural connection; anything faster is a chat client.
  const PULL_INTERVAL_MS = 60000;
  const QUEUE_KEY = "vkon_punch_queue_v1";
  // Shown when the server stops accepting writes because this tab's session ended -
  // signed out elsewhere, or expired. Names no account and no internal detail.
  const SESSION_LOST_MSG = "Your sign-in expired. Your changes are still on this device; sign in again to send them.";
  const LOCAL_ONLY = new Set([
    "vkon_session_v6",
    "vkon_theme_v6",
    "vkon_regalert_seen_v1",
  ]);

  let mode = "probing"; // "probing" | "server" | "local"
  let cache = Object.create(null);
  let versions = Object.create(null);
  let serverVersion = 0;
  let dirty = new Set();
  let flushTimer = null;
  let flushing = false;
  let session = null;
  let conflictHandler = null;
  // "A server exists" and "this browser may publish to it" are different facts, and
  // conflating them caused an anonymous visitor's seeded demo data to be PUT at the
  // server on every page load, forever, each 401 re-dirtying the store. Only a
  // verified session opens the write path.
  let authenticated = false;
  // Retries back off instead of spinning: a dropped connection must not turn into a
  // tight loop of requests on a device that is also trying to show a punch screen.
  let flushDelay = FLUSH_DEBOUNCE_MS;
  const FLUSH_DELAY_MAX_MS = 30000;
  // The server refuses every read until a forced first-login password change is
  // done. That is a gate to show, not an outage to fall back around.
  let pendingPasswordChange = false;

  // Resolved once the probe (and, if server-backed, the hydrate) has settled.
  // shared.js and both consoles wait on this before their first render.
  let resolveReady;
  const ready = new Promise((resolve) => { resolveReady = resolve; });

  function request(path, options) {
    return fetch(BASE + path, Object.assign({
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
    }, options || {})).then(async (resp) => {
      const text = await resp.text();
      let body = null;
      try { body = text ? JSON.parse(text) : null; } catch (e) { body = null; }
      if (!resp.ok) {
        const err = new Error((body && body.error && body.error.message) ||
                              `Request failed (${resp.status})`);
        err.status = resp.status;
        err.body = body && body.error ? body.error : null;
        throw err;
      }
      return body;
    });
  }

  /* ------------------------------------------------------------------ boot */

  async function boot() {
    try {
      // 404 on this path means a static-only host: not an error, just not us.
      await request("/health");
    } catch (e) {
      mode = "local";
      resolveReady();
      return;
    }
    try {
      session = await request("/auth/me");
    } catch (e) {
      session = { signedIn: false };
    }
    if (!session || !session.signedIn) {
      // No session yet: the login screen still needs to know a server exists, so
      // it can offer a real password instead of the demo shortcut. It does not get
      // to write.
      mode = "server";
      authenticated = false;
      resolveReady();
      return;
    }
    authenticated = true;
    try {
      await hydrate();
      mode = "server";
    } catch (e) {
      if (e && e.body && e.body.reason === "password_change_required") {
        // A cookie this browser does not remember, for an account still holding
        // its one-time password. Stay in server mode and demand the change: every
        // other mode here would quietly keep the person working on their own
        // local copy while the server refused to share anything with them.
        mode = "server";
        pendingPasswordChange = true;
      } else {
        // Unreachable / unparseable: keep the portal usable offline.
        mode = "local";
      }
    }
    resolveReady();
  }

  /** True when the signed-in account may not proceed until it picks a new password. */
  function needsPasswordChange() {
    return mode === "server" && pendingPasswordChange;
  }

  async function hydrate() {
    const state = await request("/state");
    cache = Object.create(null);
    versions = Object.create(null);
    Object.keys(state.stores || {}).forEach((key) => {
      cache[key] = state.stores[key].value;
      versions[key] = state.stores[key].version;
    });
    serverVersion = state.serverVersion || 0;
    await adoptLocalState();
  }

  /**
   * First run against a fresh database: whatever this browser already holds and
   * the server does not gets published, so an existing installation migrates by
   * signing in rather than by an import ritual. Only keys this browser may write
   * are offered, and a key the server already has is never touched here.
   */
  async function adoptLocalState() {
    const missing = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key || !key.startsWith("vkon_") || LOCAL_ONLY.has(key)) continue;
      if (key in versions) continue;
      if (key === QUEUE_KEY) continue;
      let value;
      try { value = JSON.parse(localStorage.getItem(key)); } catch (e) { continue; }
      if (value === null || value === undefined) continue;
      missing.push({ key, value });
    }
    for (const item of missing) {
      try {
        const res = await request(`/state/${item.key}`, {
          method: "PUT",
          body: JSON.stringify({ baseVersion: 0, value: item.value }),
        });
        cache[item.key] = item.value;
        versions[item.key] = res.version;
      } catch (e) {
        // Not permitted (an employee cannot publish the roster) or already taken.
        // Either way the server's answer stands and this browser defers to it.
      }
    }
  }

  /* --------------------------------------------------------- read and write */

  function handles(key) {
    // Server mode alone is not enough - see `authenticated` above.
    return mode === "server" && authenticated && !LOCAL_ONLY.has(key);
  }

  function read(key) {
    return key in cache ? cache[key] : undefined;
  }

  function write(key, value) {
    cache[key] = value;
    dirty.add(key);
    scheduleFlush();
  }

  function scheduleFlush() {
    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = setTimeout(flush, flushDelay);
  }

  function noteRetry() {
    flushDelay = Math.min(flushDelay * 2, FLUSH_DELAY_MAX_MS);
  }

  function noteSuccess() {
    flushDelay = FLUSH_DEBOUNCE_MS;
  }

  /** Push every changed store, one at a time, oldest edit first. */
  async function flush() {
    if (flushing || mode !== "server" || !authenticated) return;
    if (!dirty.size) { await drainPunchQueue(); return; }
    flushing = true;
    const batch = Array.from(dirty);
    dirty.clear();
    try {
      for (const key of batch) {
        const payload = { baseVersion: versions[key] || 0, value: cache[key] };
        try {
          const res = await request(`/state/${key}`, { method: "PUT", body: JSON.stringify(payload) });
          versions[key] = res.version;
          noteSuccess();
        } catch (err) {
          if (err.status === 409 && err.body && "currentValue" in err.body) {
            // Somebody else won the race. Take their version, tell the page, and
            // let the user redo the edit rather than silently losing it.
            cache[key] = err.body.currentValue;
            versions[key] = err.body.currentVersion;
            localStorage.setItem(key, JSON.stringify(err.body.currentValue));
            if (conflictHandler) conflictHandler(key);
          } else if (err.status === 401) {
            // The session went away mid-edit. Retrying is pointless and re-dirtying
            // is what turned this into a loop, so stop and say so once.
            authenticated = false;
            if (conflictHandler) conflictHandler(key, SESSION_LOST_MSG);
          } else if (err.status === 403) {
            if (conflictHandler) conflictHandler(key, err.message);
          } else {
            dirty.add(key); // network dropped: retry, but slower each time
            noteRetry();
          }
        }
      }
    } finally {
      flushing = false;
      if (dirty.size && authenticated) scheduleFlush();
      await drainPunchQueue();
    }
  }

  /** Re-read the server's state and refresh anything this tab has not touched. */
  async function pull() {
    if (mode !== "server" || !authenticated) return;
    try {
      const state = await request("/state");
      if ((state.serverVersion || 0) === serverVersion) return;
      serverVersion = state.serverVersion;
      Object.keys(state.stores || {}).forEach((key) => {
        if (dirty.has(key)) return; // an unsent local edit outranks a remote copy
        cache[key] = state.stores[key].value;
        versions[key] = state.stores[key].version;
        localStorage.setItem(key, JSON.stringify(state.stores[key].value));
      });
      if (typeof window.VKON_API.onRemoteUpdate === "function") window.VKON_API.onRemoteUpdate();
    } catch (e) { /* offline: the next pull or focus event will catch up */ }
  }

  /* ------------------------------------------------------------- punches */

  function newPunchId() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return "p-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
  }

  function queuedPunches() {
    try { return JSON.parse(localStorage.getItem(QUEUE_KEY) || "[]"); } catch (e) { return []; }
  }

  /**
   * Record a punch. Resolves as soon as it is safely stored on this device and
   * queued: a person at a gate with one bar of signal must not be told "punch
   * failed". The queue drains on the next successful flush or online event.
   */
  async function punch(kind, options) {
    const opts = options || {};
    const item = {
      punchId: opts.punchId || newPunchId(),
      kind: kind,
      employeeId: opts.employeeId || null,
      clientCapturedAt: new Date().toISOString(),
      latitude: opts.latitude !== undefined ? opts.latitude : null,
      longitude: opts.longitude !== undefined ? opts.longitude : null,
      accuracyM: opts.accuracyM !== undefined ? opts.accuracyM : null,
    };
    const queue = queuedPunches();
    queue.push(item);
    localStorage.setItem(QUEUE_KEY, JSON.stringify(queue));

    const sent = await sendPunch(item);
    if (sent) await pull();
    return { queued: !sent, punchId: item.punchId, record: sent };
  }

  function sendPunch(item) {
    if (mode !== "server" || !authenticated) return Promise.resolve(null);
    return request("/punches", { method: "POST", body: JSON.stringify(item) })
      .then((res) => {
        const rest = queuedPunches().filter(p => p.punchId !== item.punchId);
        localStorage.setItem(QUEUE_KEY, JSON.stringify(rest));
        return res;
      })
      .catch(() => null);
  }

  async function drainPunchQueue() {
    if (mode !== "server" || !authenticated) return;
    const pending = queuedPunches();
    if (!pending.length) return;
    for (const item of pending) {
      const sent = await sendPunch(item);
      if (!sent) return; // still offline; keep the rest queued
    }
  }

  /* --------------------------------------------------------------- auth */

  async function login(identifier, password) {
    try {
      session = await request("/auth/login", {
        method: "POST",
        body: JSON.stringify({ identifier: identifier, password: password }),
      });
    } catch (err) {
      if (err.status === 429) return { code: "throttled", message: err.message };
      if (err.status === 401) return { code: "invalid", message: err.message };
      return { code: "unreachable", message: err.message };
    }
    mode = "server";
    authenticated = true;
    if (session.mustChangePassword) {
      // Authenticated but not yet authorised to read anything. The caller has to
      // send the person to the change-password form; hydrating here would fail.
      pendingPasswordChange = true;
      return { code: "passwordChange", session: session };
    }
    try {
      await hydrate();
    } catch (e) {
      // The password verified, so the identity is real even if state could not be
      // fetched. Keep the server session and let the cache fill on the next pull.
      pendingPasswordChange = false;
    }
    return { code: session.role === "admin" ? "admin" : "employee", session: session };
  }

  /**
   * Choose a new password for the signed-in account. The server validates it
   * (length, blocklist, not the username) and clears the forced-change flag.
   */
  async function changePassword(currentPassword, newPassword) {
    try {
      await request("/auth/password", {
        method: "POST",
        body: JSON.stringify({ currentPassword: currentPassword, newPassword: newPassword }),
      });
    } catch (err) {
      return { ok: false, message: err.message || "Could not change the password." };
    }
    pendingPasswordChange = false;
    authenticated = true;
    try {
      await hydrate();
    } catch (e) { /* the next pull catches up */ }
    return { ok: true };
  }

  async function logout() {
    try { await request("/auth/logout", { method: "POST" }); } catch (e) { /* already gone */ }
    cache = Object.create(null);
    versions = Object.create(null);
    dirty.clear();
    session = null;
    authenticated = false;
    pendingPasswordChange = false;
  }

  function currentSession() { return session; }
  function isServerBacked() { return mode === "server"; }
  function isLocalOnly() { return mode === "local"; }
  function isProbing() { return mode === "probing"; }
  function pendingPunchCount() { return queuedPunches().length; }

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) { flush(); pull(); }
  });
  window.addEventListener("online", () => { flush(); drainPunchQueue(); });
  window.addEventListener("beforeunload", () => { if (dirty.size) flush(); });
  setInterval(() => { if (!document.hidden) pull(); }, PULL_INTERVAL_MS);

  boot();

  return {
    ready,
    handles, read, write, flush, pull,
    punch, login, logout, changePassword, boot,
    currentSession, isServerBacked, isProbing, isLocalOnly, pendingPunchCount,
    needsPasswordChange,
    onConflict: (fn) => { conflictHandler = fn; },
    onRemoteUpdate: null,
  };
})();
