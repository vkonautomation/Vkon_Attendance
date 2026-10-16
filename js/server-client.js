/**
 * VKON Server Client
 * Thin client-side adapter that turns the static localStorage portal into a
 * cached view of an authoritative FastAPI backend.
 *
 * Responsibilities:
 *   - Bootstrap the session from the HttpOnly cookie (GET /api/session).
 *   - Hydrate the localStorage cache from GET /api/state (role-filtered).
 *   - Proxy setStore() writes to PATCH /api/state/{key} (debounced), where the
 *     server enforces role + ownership permissions (a 403/401 is surfaced).
 *   - Provide async auth helpers used by app.js / admin.js.
 *
 * The localStorage cache is kept intact so the existing synchronous UI keeps
 * working; the server remains the single source of truth for what is allowed.
 */
(function () {
  "use strict";

  // Storage keys that are backed by the server (mirrors server STATE_KEYS).
  var STATE_KEY_LIST = [
    "vkon_employees_v6",
    "vkon_records_v6",
    "vkon_wfh_v6",
    "vkon_leaves_v6",
    "vkon_holidays_v6",
    "vkon_settings_v6",
    "vkon_regularisations_v6",
    "vkon_leave_quotas_v6",
    "vkon_min_work_policy_v6"
  ];
  var SYNC_KEYS = {};
  STATE_KEY_LIST.forEach(function (k) { SYNC_KEYS[k] = true; });

  var SESSION_KEY = "vkon_session_v6";

  var VKON = {
    auth: null,          // current session user (or null)
    mfaRequired: false,  // set when an admin password step succeeded but TOTP is pending
    preauthToken: null
  };

  var _readyResolve;
  VKON.ready = new Promise(function (res) { _readyResolve = res; });

  var _syncTimers = {};

  function apiFetch(path, options) {
    options = options || {};
    var opts = {
      method: options.method || "GET",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" }
    };
    if (options.body !== undefined) opts.body = JSON.stringify(options.body);
    return fetch(path, opts).then(function (resp) {
      return resp.json()
        .catch(function () { return null; })
        .then(function (data) {
          return { ok: resp.ok, status: resp.status, data: data };
        });
    });
  }

  function detailMessage(data, fallback) {
    if (data && typeof data.detail === "string") return data.detail;
    return fallback;
  }

  function toast(msg, type) {
    if (typeof window.showToast === "function") window.showToast(msg, type || "error");
  }

  function hydrateCache(state) {
    if (!state || typeof state !== "object") return;
    Object.keys(state).forEach(function (key) {
      try { localStorage.setItem(key, JSON.stringify(state[key])); } catch (e) {}
    });
  }

  function loadState() {
    return apiFetch("/api/state").then(function (r) {
      if (r.ok) hydrateCache(r.data);
      return r;
    });
  }

  function writeClientSession(user) {
    if (!user) return;
    var session = {
      username: user.username,
      employeeId: user.employee_id,
      name: user.name,
      role: user.kind === "admin" ? "admin" : "employee",
      loginTime: new Date().toISOString()
    };
    try {
      localStorage.setItem(SESSION_KEY, JSON.stringify(session));
      sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
    } catch (e) {}
  }

  function clearClientSession() {
    try {
      localStorage.removeItem(SESSION_KEY);
      sessionStorage.removeItem(SESSION_KEY);
    } catch (e) {}
  }

  function forceLogout() {
    clearClientSession();
    VKON.auth = null;
    toast("Your session expired. Please sign in again.", "info");
    setTimeout(function () { window.location.href = "index.html"; }, 600);
  }

  // Debounced server persistence for a single storage key.
  VKON.syncStore = function (key, value) {
    if (!SYNC_KEYS[key]) return; // session/theme/other client-only keys
    if (!VKON.auth) return;      // nothing to sync until authenticated
    clearTimeout(_syncTimers[key]);
    _syncTimers[key] = setTimeout(function () {
      apiFetch("/api/state/" + encodeURIComponent(key), { method: "PATCH", body: { value: value } })
        .then(function (r) {
          if (r.status === 401) { forceLogout(); return; }
          if (r.status === 403) { toast(detailMessage(r.data, "You are not allowed to modify that data."), "error"); return; }
          if (!r.ok) { toast(detailMessage(r.data, "Could not save changes."), "error"); }
        })
        .catch(function () { toast("Network error while saving.", "error"); });
    }, 250);
  };

  VKON.login = function (identifier, password) {
    return apiFetch("/api/auth/login", { method: "POST", body: { identifier: identifier, password: password } })
      .then(function (r) {
        if (r.status === 429) { return { ok: false, locked: true, message: detailMessage(r.data, "Too many attempts. Try again later.") }; }
        if (!r.ok || !r.data) { return { ok: false, message: detailMessage(r.data, "Invalid credentials.") }; }
        if (r.data.mfa_required) {
          VKON.mfaRequired = true;
          VKON.preauthToken = r.data.preauth_token;
          return { ok: true, mfaRequired: true };
        }
        VKON.auth = r.data.user;
        VKON.mfaRequired = false;
        writeClientSession(r.data.user);
        return loadState().then(function () {
          return { ok: true, role: r.data.role, user: r.data.user };
        });
      });
  };

  VKON.verifyMfa = function (code) {
    if (!VKON.preauthToken) return Promise.resolve({ ok: false, message: "Start the sign-in again." });
    return apiFetch("/api/auth/mfa/verify", { method: "POST", body: { preauth_token: VKON.preauthToken, code: code } })
      .then(function (r) {
        if (!r.ok || !r.data) { return { ok: false, message: detailMessage(r.data, "Invalid authentication code.") }; }
        VKON.auth = r.data.user;
        VKON.mfaRequired = false;
        VKON.preauthToken = null;
        writeClientSession(r.data.user);
        return loadState().then(function () {
          return { ok: true, role: r.data.role, user: r.data.user };
        });
      });
  };

  VKON.logout = function () {
    return apiFetch("/api/auth/logout", { method: "POST" }).then(function () {
      clearClientSession();
      VKON.auth = null;
    });
  };

  VKON.mfaSetup = function () {
    return apiFetch("/api/auth/mfa/setup");
  };

  // Bootstrap: resolve the current session (from cookie) and hydrate if authed.
  function boot() {
    return apiFetch("/api/session")
      .then(function (r) {
        if (r.ok && r.data && r.data.user) {
          VKON.auth = r.data.user;
          writeClientSession(r.data.user);
          return loadState().then(function () { return r.data.user; });
        }
        clearClientSession();
        VKON.auth = null;
        return null;
      })
      .catch(function () { VKON.auth = null; return null; })
      .then(function (user) { _readyResolve(user); return user; });
  }

  if (typeof window !== "undefined") {
    window.VKON = VKON;
    if (typeof document !== "undefined") {
      if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", boot);
      } else {
        boot();
      }
    }
  }
})();
