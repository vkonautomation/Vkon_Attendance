/**
 * ConfirmDecisionModal — a single reusable, accessible confirmation dialog used
 * by every approval action in the app (Admin Console Approvals page and the
 * employee-portal Team Requests page). It replaces all window.prompt()/confirm()
 * usage in the approval flows.
 *
 * Usage:
 *   ConfirmDecisionModal.open({
 *     title: "Approve on behalf of manager",
 *     summary: "Chiranth Gowda \u00b7 WFH \u00b7 2026-10-27",   // one-line context
 *     detail: "<p>...</p>",                                     // optional extra HTML (e.g. LOP estimate)
 *     notice: "You are acting on behalf of the manager...",     // optional highlighted notice
 *     actionLabel: "Confirm approval",
 *     actionStyle: "primary" | "danger" | "warning",
 *     reasonRequired: true,                                     // reject / on-behalf => required
 *     reasonLabel: "Reason",                                    // or "Comment"
 *     placeholder: "Shown to the employee",
 *     onConfirm: async function (comment) {
 *       // perform the action; return { ok: true } to close, or
 *       // { ok: false, error: "message" } to keep open + show error.
 *     }
 *   });
 *
 * The modal: opens centered over a dimmed backdrop, focuses the text field,
 * traps keyboard focus, closes on Escape / Cancel (NOT on backdrop click so
 * typed text is never lost), returns focus to the triggering element, enforces
 * a required reason (Confirm disabled until non-whitespace), shows a 300-char
 * counter, and disables both buttons with a loading state during onConfirm to
 * prevent double submission. Works at mobile width (near full-width sheet).
 */
(function () {
  "use strict";

  var MAX = 300;
  var root = null;
  var lastFocused = null;
  var isOpen = false;
  var closedByConfirm = false;

  function ensureRoot() {
    if (root) return root;
    root = document.createElement("div");
    root.className = "cdm-root";
    root.innerHTML =
      '<div class="cdm-backdrop" tabindex="-1"></div>' +
      '<div class="cdm-dialog" role="dialog" aria-modal="true" aria-labelledby="cdmTitle" aria-describedby="cdmSummary">' +
        '<div class="cdm-handle" aria-hidden="true"></div>' +
        '<h3 class="cdm-title" id="cdmTitle"></h3>' +
        '<p class="cdm-summary" id="cdmSummary"></p>' +
        '<div class="cdm-detail" id="cdmDetail"></div>' +
        '<div class="cdm-notice" id="cdmNotice" hidden></div>' +
        '<label class="cdm-field-label" id="cdmFieldLabel" for="cdmText">Comment</label>' +
        '<textarea class="cdm-text" id="cdmText" rows="3" maxlength="' + MAX + '"></textarea>' +
        '<div class="cdm-counter"><span id="cdmError" class="cdm-error" role="alert" hidden></span>' +
          '<span class="cdm-count"><span id="cdmCount">0</span>/' + MAX + '</span></div>' +
        '<div class="cdm-actions">' +
          '<button type="button" class="btn btn-xs btn-ghost cdm-cancel" id="cdmCancel">Cancel</button>' +
          '<button type="button" class="btn btn-xs cdm-confirm" id="cdmConfirm">Confirm</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(root);
    return root;
  }

  function el(id) { return document.getElementById(id); }

  function focusables() {
    return Array.prototype.filter.call(
      root.querySelectorAll('button, textarea, [href], input, select'),
      function (n) { return !n.disabled && n.offsetParent !== null; }
    );
  }

  function onKeydown(e) {
    if (!isOpen) return;
    if (e.key === "Escape") { e.preventDefault(); close(); return; }
    if (e.key === "Tab") {
      var f = focusables();
      if (!f.length) return;
      var first = f[0], last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  }

  function updateCounter() {
    var t = el("cdmText");
    el("cdmCount").textContent = String(t.value.length);
  }

  function validate(state) {
    var text = el("cdmText").value;
    var err = el("cdmError");
    var confirmBtn = el("cdmConfirm");
    if (state.reasonRequired && !text.trim()) {
      err.textContent = "A " + (state.reasonLabel || "reason").toLowerCase() + " is required.";
      err.hidden = false;
      confirmBtn.disabled = true;
      return false;
    }
    err.hidden = true;
    confirmBtn.disabled = false;
    return true;
  }

  var currentState = null;

  function onConfirmClick() {
    var state = currentState;
    if (!state) return;
    if (!validate(state)) return;
    var comment = el("cdmText").value.trim();
    var cancelBtn = el("cdmCancel"), confirmBtn = el("cdmConfirm"), text = el("cdmText");
    // Prevent double submission: disable both + loading state.
    cancelBtn.disabled = true;
    confirmBtn.disabled = true;
    text.readOnly = true;
    confirmBtn.classList.add("is-loading");
    confirmBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Working\u2026';

    function restore() {
      cancelBtn.disabled = false;
      text.readOnly = false;
      confirmBtn.classList.remove("is-loading");
      confirmBtn.innerHTML = state.actionLabel || "Confirm";
      validate(state);
    }

    Promise.resolve()
      .then(function () { return (state.onConfirm || state.run)(comment); })
      .then(function (res) {
        if (res && res.ok === false) {
          var err = el("cdmError");
          err.textContent = res.error || "Something went wrong. Please try again.";
          err.hidden = false;
          restore();
        } else {
          closedByConfirm = true;
          close();
        }
      })
      .catch(function () {
        var err = el("cdmError");
        err.textContent = "Something went wrong. Please try again.";
        err.hidden = false;
        restore();
      });
  }

  function close() {
    if (!isOpen) return;
    isOpen = false;
    root.classList.remove("open");
    document.removeEventListener("keydown", onKeydown, true);
    var state = currentState;
    currentState = null;
    // If dismissed without a successful confirm, notify the caller so it can
    // re-enable the triggering buttons.
    if (!closedByConfirm && state && typeof state.onCancel === "function") {
      try { state.onCancel(); } catch (e) { /* ignore */ }
    }
    closedByConfirm = false;
    var back = lastFocused;
    lastFocused = null;
    if (back && typeof back.focus === "function") { try { back.focus(); } catch (e) { /* ignore */ } }
  }

  function open(options) {
    options = options || {};
    ensureRoot();
    lastFocused = document.activeElement;
    currentState = options;
    closedByConfirm = false;

    el("cdmTitle").textContent = options.title || "Confirm action";
    el("cdmSummary").textContent = options.summary || "";
    el("cdmDetail").innerHTML = options.detail || "";
    el("cdmDetail").style.display = options.detail ? "" : "none";

    var notice = el("cdmNotice");
    if (options.notice) { notice.innerHTML = options.notice; notice.hidden = false; }
    else { notice.innerHTML = ""; notice.hidden = true; }

    var label = options.reasonLabel || "Comment";
    el("cdmFieldLabel").textContent = label;
    var text = el("cdmText");
    text.value = "";
    text.readOnly = false;
    text.placeholder = options.placeholder || (options.reasonRequired ? "Required \u2014 shown to the employee" : "Optional \u2014 shown to the employee");

    var confirmBtn = el("cdmConfirm");
    confirmBtn.disabled = false;
    confirmBtn.classList.remove("is-loading");
    confirmBtn.classList.remove("btn-primary", "btn-danger", "btn-warning");
    var style = options.actionStyle || "primary";
    confirmBtn.classList.add(style === "danger" ? "btn-danger" : style === "warning" ? "btn-warning" : "btn-primary");
    confirmBtn.innerHTML = '<i class="fa-solid ' + (style === "danger" ? "fa-xmark" : "fa-check") + '"></i> ' + (options.actionLabel || "Confirm");

    el("cdmCancel").disabled = false;
    updateCounter();
    validate(options);

    root.classList.add("open");
    isOpen = true;
    document.addEventListener("keydown", onKeydown, true);
    setTimeout(function () { text.focus(); }, 20);
  }

  // Wire static listeners once.
  function init() {
    ensureRoot();
    el("cdmCancel").addEventListener("click", close);
    el("cdmConfirm").addEventListener("click", onConfirmClick);
    // Backdrop click intentionally does NOT close (avoid losing typed text).
    el("cdmText").addEventListener("input", function () {
      updateCounter();
      if (currentState) validate(currentState);
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

  window.ConfirmDecisionModal = { open: open, close: close };
})();
