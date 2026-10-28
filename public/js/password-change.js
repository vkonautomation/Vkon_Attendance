/**
 * Forced password change (server-backed builds only).
 *
 * Accounts created from the roster start with a one-time password written to a
 * file on the server, and the backend refuses every data request until the person
 * replaces it. That is the whole reason this dialog exists: without it a new
 * employee signs in successfully and then sees an empty portal, because hydration
 * was rejected with a 403 they cannot interpret.
 *
 * Self-contained on purpose. It carries its own styles rather than reaching into
 * styles.css, so it works identically in both consoles and cannot collide with a
 * theme rule.
 */
window.VKON_PASSWORD_CHANGE = (function () {
  "use strict";

  const MIN_CHARS = 8;      // mirrors server/security.py:MIN_PASSWORD_CHARS
  const MAX_BYTES = 72;     // bcrypt truncates silently past this; reject instead
  const BLOCKLIST = ["password", "vkon1234", "admin123", "12345678"];

  let overlay = null;
  let busy = false;

  const STYLES = `
.vkon-pw-overlay { position: fixed; inset: 0; z-index: 100000; display: flex;
  align-items: center; justify-content: center; padding: 16px;
  background: rgba(8, 12, 24, 0.72); backdrop-filter: blur(3px); }
.vkon-pw-card { width: min(420px, 100%); box-sizing: border-box; padding: 24px;
  border-radius: 16px; border: 1px solid rgba(148, 163, 184, 0.28);
  background: #0f172a; color: #e2e8f0;
  box-shadow: 0 24px 60px rgba(0, 0, 0, 0.45);
  font-family: inherit; }
.vkon-pw-card h2 { margin: 0 0 6px; font-size: 18px; }
.vkon-pw-card p.vkon-pw-lede { margin: 0 0 16px; font-size: 13px; line-height: 1.5;
  color: #94a3b8; }
.vkon-pw-field { margin-bottom: 12px; }
.vkon-pw-field label { display: block; font-size: 11px; letter-spacing: 0.06em;
  text-transform: uppercase; color: #94a3b8; margin-bottom: 5px; }
.vkon-pw-field input { width: 100%; box-sizing: border-box; padding: 11px 12px;
  font-size: 15px; border-radius: 10px; outline: none;
  border: 1px solid rgba(148, 163, 184, 0.35); background: #111c33; color: #e2e8f0; }
.vkon-pw-field input:focus { border-color: #38bdf8; }
.vkon-pw-actions { display: flex; gap: 10px; margin-top: 18px; }
.vkon-pw-actions button { flex: 1; padding: 11px 14px; font-size: 14px;
  font-weight: 600; border-radius: 10px; cursor: pointer; border: 1px solid transparent; }
.vkon-pw-save { background: #38bdf8; color: #04202e; }
.vkon-pw-cancel { background: transparent; color: #94a3b8;
  border-color: rgba(148, 163, 184, 0.35); }
.vkon-pw-actions button:disabled { opacity: 0.55; cursor: not-allowed; }
.vkon-pw-msg { min-height: 18px; margin-top: 12px; font-size: 12.5px; line-height: 1.45;
  color: #f87171; white-space: pre-wrap; }
.vkon-pw-msg.ok { color: #4ade80; }
`;

  function ensureStyleTag() {
    if (document.getElementById("vkon-pw-styles")) return;
    const tag = document.createElement("style");
    tag.id = "vkon-pw-styles";
    tag.textContent = STYLES;
    document.head.appendChild(tag);
  }

  /** Client-side mirror of the server rules, for instant feedback. */
  function problem(password, username) {
    if (!password || password.trim().length < MIN_CHARS) {
      return `Choose at least ${MIN_CHARS} characters.`;
    }
    if (new TextEncoder().encode(password).length > MAX_BYTES) {
      return `Keep it under ${MAX_BYTES} characters.`;
    }
    if (username && password.toLowerCase() === String(username).toLowerCase()) {
      return "Do not use your username as your password.";
    }
    if (BLOCKLIST.indexOf(password.toLowerCase()) !== -1) {
      return "That password is blocked. Choose another.";
    }
    return null;
  }

  function message(text, isOk) {
    const el = document.getElementById("vkon-pw-msg");
    if (!el) return;
    el.textContent = text || "";
    el.className = "vkon-pw-msg" + (isOk ? " ok" : "");
  }

  const DEFAULT_LEDE = 'Your account was created with a temporary password. The '
    + 'attendance server will not share any data until you replace it with one '
    + 'only you know.';

  function close() {
    if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay);
    overlay = null;
  }

  function isOpen() {
    return !!(overlay && overlay.parentNode);
  }

  /**
   * @param opts.requireCurrent  false when the account is mid-first-login and the
   *   one-time password is already in the sign-in field, so do not ask twice.
   * @param opts.onSuccess       called after the server has accepted the change.
   */
  function open(opts) {
    const options = opts || {};
    if (isOpen()) return;
    ensureStyleTag();

    const requireCurrent = options.requireCurrent !== false;
    const session = options.session || (window.VKON_API && VKON_API.currentSession
      ? VKON_API.currentSession() : null) || {};

    overlay = document.createElement("div");
    overlay.className = "vkon-pw-overlay";
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    // The markup below is a fixed skeleton with no interpolation: every string that
    // comes from a caller or from the server is written in with textContent, so no
    // path from untrusted text into the HTML parser exists here.
    overlay.innerHTML =
      '<div class="vkon-pw-card">' +
        '<h2>Set a new password</h2>' +
        '<p class="vkon-pw-lede"></p>' +
        '<div class="vkon-pw-field" data-current-field><label for="vkon-pw-current">Current password</label>' +
        '<input type="password" id="vkon-pw-current" autocomplete="current-password"></div>' +
        '<div class="vkon-pw-field"><label for="vkon-pw-new">New password</label>' +
        '<input type="password" id="vkon-pw-new" autocomplete="new-password"></div>' +
        '<div class="vkon-pw-field"><label for="vkon-pw-confirm">Repeat new password</label>' +
        '<input type="password" id="vkon-pw-confirm" autocomplete="new-password"></div>' +
        '<div class="vkon-pw-actions">' +
          '<button type="button" class="vkon-pw-cancel" id="vkon-pw-cancel">Later</button>' +
          '<button type="button" class="vkon-pw-save" id="vkon-pw-save">Save password</button>' +
        '</div>' +
        '<div class="vkon-pw-msg" id="vkon-pw-msg"></div>' +
      '</div>';

    overlay.querySelector(".vkon-pw-lede").textContent = options.message || DEFAULT_LEDE;
    if (!requireCurrent) {
      const currentField = overlay.querySelector("[data-current-field]");
      if (currentField) currentField.parentNode.removeChild(currentField);
    }
    if (!options.dismissible) {
      const cancel = overlay.querySelector("#vkon-pw-cancel");
      if (cancel) cancel.parentNode.removeChild(cancel);
    }
    document.body.appendChild(overlay);

    const save = document.getElementById("vkon-pw-save");
    const cancel = document.getElementById("vkon-pw-cancel");
    if (cancel) cancel.addEventListener("click", () => {
      if (typeof options.onDismiss === "function") options.onDismiss();
      close();
    });

    async function submit() {
      if (busy) return;
      message("");
      const currentEl = document.getElementById("vkon-pw-current");
      const newEl = document.getElementById("vkon-pw-new");
      const confirmEl = document.getElementById("vkon-pw-confirm");
      const current = currentEl ? currentEl.value : "";
      const next = newEl ? newEl.value : "";
      const repeat = confirmEl ? confirmEl.value : "";

      if (requireCurrent && !current) { message("Enter your current password."); return; }
      const bad = problem(next, session.username);
      if (bad) { message(bad); return; }
      if (next !== repeat) { message("The two new passwords do not match."); return; }

      busy = true;
      save.disabled = true;
      try {
        const res = await VKON_API.changePassword(current, next);
        if (!res.ok) { message(res.message || "The server rejected that password."); return; }
        // Never leave the typed secrets sitting in the DOM after success.
        [currentEl, newEl, confirmEl].forEach(el => { if (el) el.value = ""; });
        close();
        if (typeof options.onSuccess === "function") options.onSuccess();
      } finally {
        busy = false;
        save.disabled = false;
      }
    }

    save.addEventListener("click", submit);
    overlay.addEventListener("keydown", (e) => { if (e.key === "Enter") submit(); });
    const focusTarget = requireCurrent ? "vkon-pw-current" : "vkon-pw-new";
    const first = document.getElementById(focusTarget);
    if (first) first.focus();
  }

  return { open, close, isOpen, problem };
})();
