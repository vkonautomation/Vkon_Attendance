// ============================================================================
// Cross-device data transfer for the pure-static (localStorage) build.
//
// The app keeps every record in the browser's localStorage, which is private to
// each device. That means data entered on a phone never appears on a laptop.
// This module adds a lightweight Export / Import pair to the sidebar footer of
// BOTH the employee portal and the admin console so a user can move their whole
// dataset between devices by hand:
//
//   Export -> downloads a JSON snapshot of all `vkon_*` keys (minus the session)
//   Import -> restores that snapshot into this device's localStorage, then reloads
//
// It intentionally mirrors the exact storage layer used by shared.js
// (localStorage + the `vkon_` key prefix).
// ============================================================================
(function () {
  "use strict";

  var APP_KEY_PREFIX = "vkon_";
  // The login session is device-specific; carrying it across devices would
  // silently sign the other device in as this user, so we skip it on export.
  var SESSION_KEY = "vkon_session_v6";

  function _toast(msg, type) {
    try {
      if (typeof window.showToast === "function") window.showToast(msg, type);
      else console.log("[" + (type || "info") + "] " + msg);
    } catch (e) { /* non-fatal */ }
  }

  function _stamp() {
    var d = new Date();
    var p = function (n) { return String(n).padStart(2, "0"); };
    return "" + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) +
      "-" + p(d.getHours()) + p(d.getMinutes());
  }

  // Collect every app-owned key. Values are parsed back to objects where valid so
  // the backup file is human-readable; raw strings are kept for anything odd.
  function _collect() {
    var keys = {};
    for (var i = 0; i < localStorage.length; i++) {
      var k = localStorage.key(i);
      if (!k || k.indexOf(APP_KEY_PREFIX) !== 0 || k === SESSION_KEY) continue;
      var raw = localStorage.getItem(k);
      try { keys[k] = JSON.parse(raw); }
      catch (e) { keys[k] = raw; }
    }
    return keys;
  }

  function _exportData() {
    var keys = _collect();
    var names = Object.keys(keys);
    if (!names.length) { _toast("Nothing to export yet.", "error"); return; }
    var payload = {
      _meta: {
        app: "VKON Attendance",
        schema: 1,
        exportedAt: new Date().toISOString(),
        sections: names.length
      },
      keys: keys
    };
    var blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = "vkon-attendance-backup-" + _stamp() + ".json";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    _toast("Backup downloaded (" + names.length + " sections). Send this file to your other device.", "success");
  }

  function _readFile(file) {
    return new Promise(function (resolve, reject) {
      var r = new FileReader();
      r.onload = function () {
        try { resolve(JSON.parse(r.result)); }
        catch (e) { reject(new Error("That file isn't a valid backup (could not read JSON).")); }
      };
      r.onerror = function () { reject(new Error("Could not read the file.")); };
      r.readAsText(file);
    });
  }

  function _importData(file) {
    _readFile(file).then(function (data) {
      if (!data || !data.keys || typeof data.keys !== "object") {
        _toast("Unrecognised backup format.", "error");
        return;
      }
      var names = Object.keys(data.keys);
      if (!names.length) { _toast("That backup is empty.", "error"); return; }
      var when = data._meta && data._meta.exportedAt
        ? " (exported " + new Date(data._meta.exportedAt).toLocaleString() + ")" : "";
      var ok = window.confirm(
        "Restore " + names.length + " sections from this backup" + when + "?\n\n" +
        "This REPLACES all VKON data on THIS device and cannot be undone."
      );
      if (!ok) return;
      // Wipe existing app keys first (keep the current session so we stay logged in),
      // then write the imported snapshot.
      var toRemove = [];
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        if (k && k.indexOf(APP_KEY_PREFIX) === 0 && k !== SESSION_KEY) toRemove.push(k);
      }
      toRemove.forEach(function (k) { localStorage.removeItem(k); });
      names.forEach(function (k) {
        var v = data.keys[k];
        try { localStorage.setItem(k, typeof v === "string" ? v : JSON.stringify(v)); }
        catch (e) { console.error("import key failed:", k, e); }
      });
      _toast("Backup restored. Reloading\u2026", "success");
      setTimeout(function () { window.location.reload(); }, 700);
    }).catch(function (err) { _toast(err.message, "error"); });
  }

  function _makeBtn(icon, title, onClick) {
    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "icon-btn sidebar-tool-btn";
    btn.title = title;
    btn.setAttribute("aria-label", title);
    var i = document.createElement("i");
    i.className = "fa-solid " + icon;
    btn.appendChild(i);
    btn.addEventListener("click", onClick);
    return btn;
  }

  function init() {
    var footer = document.querySelector(".sidebar-footer");
    if (!footer || footer.querySelector("[data-vkon-transfer]")) return;

    var exportBtn = _makeBtn(
      "fa-download",
      "Download a backup of all data (to move it to another device)",
      _exportData
    );
    exportBtn.setAttribute("data-vkon-transfer", "export");

    var fileInput = document.createElement("input");
    fileInput.type = "file";
    fileInput.accept = "application/json,.json";
    fileInput.style.display = "none";
    fileInput.setAttribute("data-vkon-transfer", "file");
    fileInput.addEventListener("change", function (e) {
      var f = e.target.files && e.target.files[0];
      if (f) _importData(f);
      e.target.value = ""; // allow re-selecting the same file
    });

    var importBtn = _makeBtn(
      "fa-upload",
      "Restore data from a backup file",
      function () { fileInput.click(); }
    );
    importBtn.setAttribute("data-vkon-transfer", "import");

    // Insert just before the logout control so grouping stays tidy.
    var logout = footer.querySelector("#logoutBtn, #adminLogoutBtn");
    if (logout && logout.parentNode === footer) {
      footer.insertBefore(exportBtn, logout);
      footer.insertBefore(importBtn, logout);
    } else {
      footer.appendChild(exportBtn);
      footer.appendChild(importBtn);
    }
    footer.appendChild(fileInput);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
