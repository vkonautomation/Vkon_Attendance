/*
 * js/pwa.js -- Progressive Web App glue for both the employee portal and the
 * admin console. It does three things and nothing else, so it cannot disturb the
 * attendance logic:
 *
 *   1. Registers the service worker and surfaces an "Update available - Reload"
 *      toast when a new build is waiting (the worker never swaps in on its own).
 *   2. Shows a slim offline banner when the device loses the network, so a queued
 *      punch is visibly "will sync" rather than silently pending.
 *   3. Captures the install prompt and exposes VKON_PWA.promptInstall() so a page
 *      can offer an explicit "Install app" action.
 *
 * It intentionally reuses the app's own palette and never edits styles.css.
 */
(function () {
  "use strict";

  // Was there already a controller when this page loaded? If so, a later
  // controllerchange means an UPDATE (reload is safe). On a first install the
  // controller appears for the first time and we must NOT reload.
  var hadController = !!(navigator.serviceWorker && navigator.serviceWorker.controller);

  function injectStyles() {
    if (document.getElementById("vkon-pwa-style")) return;
    var css =
      ".vkon-pwa-toast,.vkon-pwa-offline{position:fixed;z-index:2147483000;left:50%;transform:translateX(-50%);" +
      "display:flex;align-items:center;gap:.75rem;max-width:min(92vw,460px);padding:.6rem .8rem;border-radius:12px;" +
      "font:600 .85rem/1.2 'Inter',system-ui,sans-serif;box-shadow:0 10px 30px -12px rgba(15,23,42,.45);" +
      "background:#0f172a;color:#f8fafc;border:1px solid rgba(148,163,184,.28)}" +
      ".vkon-pwa-toast{bottom:16px}.vkon-pwa-offline{top:12px;bottom:auto;background:#7c2d12;border-color:#ea580c}" +
      ".vkon-pwa-toast button,.vkon-pwa-offline button{cursor:pointer;border:0;border-radius:8px;padding:.4rem .7rem;" +
      "font:700 .8rem 'Inter',system-ui,sans-serif;background:#ea580c;color:#fff}" +
      ".vkon-pwa-toast button.ghost{background:transparent;color:#cbd5e1;border:1px solid rgba(203,213,225,.4)}" +
      ".vkon-pwa-offline[hidden],.vkon-pwa-toast[hidden]{display:none}";
    var el = document.createElement("style");
    el.id = "vkon-pwa-style";
    el.textContent = css;
    document.head.appendChild(el);
  }

  /* ------------------------------------------------------- update toast */
  function showUpdateToast(worker) {
    injectStyles();
    if (document.getElementById("vkon-pwa-toast")) return;
    var bar = document.createElement("div");
    bar.id = "vkon-pwa-toast";
    bar.className = "vkon-pwa-toast";
    bar.setAttribute("role", "status");
    var label = document.createElement("span");
    label.textContent = "A new version is available.";
    var reloadBtn = document.createElement("button");
    reloadBtn.type = "button";
    reloadBtn.id = "vkon-pwa-reload";
    reloadBtn.textContent = "Reload";
    var dismissBtn = document.createElement("button");
    dismissBtn.type = "button";
    dismissBtn.className = "ghost";
    dismissBtn.id = "vkon-pwa-dismiss";
    dismissBtn.textContent = "Later";
    bar.appendChild(label);
    bar.appendChild(reloadBtn);
    bar.appendChild(dismissBtn);
    document.body.appendChild(bar);
    reloadBtn.addEventListener("click", function () {
      // Hand control to the waiting worker; the controllerchange listener reloads.
      var w = worker || (navigator.serviceWorker && navigator.serviceWorker.controller);
      if (w) w.postMessage({ action: "SKIP_WAITING" });
      else window.location.reload();
    });
    dismissBtn.addEventListener("click", function () {
      bar.remove();
    });
  }

  function watchForUpdate(reg) {
    if (reg.waiting) showUpdateToast(reg.waiting);
    reg.addEventListener("updatefound", function () {
      var nw = reg.installing;
      if (!nw) return;
      nw.addEventListener("statechange", function () {
        // 'installed' + an existing controller => this is an update, not a first install.
        if (nw.state === "installed" && hadController) showUpdateToast(nw);
      });
    });
    // Periodically ask for an update so a long-lived tab notices new builds.
    setInterval(function () { reg.update().catch(function () { /* offline */ }); }, 60 * 60 * 1000);
  }

  /* ------------------------------------------------------- offline banner */
  function setOfflineUI(isOffline) {
    injectStyles();
    var bar = document.getElementById("vkon-pwa-offline");
    if (isOffline) {
      if (!bar) {
        bar = document.createElement("div");
        bar.id = "vkon-pwa-offline";
        bar.className = "vkon-pwa-offline";
        bar.setAttribute("role", "status");
        bar.textContent = "You're offline - punches are saved on this device and will sync automatically.";
        document.body.appendChild(bar);
      }
      bar.hidden = false;
    } else if (bar) {
      bar.hidden = true;
    }
  }

  /* ------------------------------------------------------- install prompt */
  var deferredPrompt = null;
  window.addEventListener("beforeinstallprompt", function (e) {
    e.preventDefault();
    deferredPrompt = e;
    window.VKON_PWA = window.VKON_PWA || {};
    window.VKON_PWA.canInstall = function () { return !!deferredPrompt; };
    window.VKON_PWA.promptInstall = function () {
      if (!deferredPrompt) return Promise.resolve({ outcome: "unsupported" });
      var choice = deferredPrompt.prompt();
      deferredPrompt = null;
      return choice.then(function () { return { outcome: "shown" }; }).catch(function () { return { outcome: "error" }; });
    };
  });
  window.addEventListener("appinstalled", function () { deferredPrompt = null; });

  /* ------------------------------------------------------------- boot */
  function boot() {
    window.addEventListener("online", function () { setOfflineUI(false); });
    window.addEventListener("offline", function () { setOfflineUI(true); });
    setOfflineUI(!navigator.onLine);

    if (!("serviceWorker" in navigator)) return;
    window.addEventListener("load", function () {
      navigator.serviceWorker.register("/sw.js")
        .then(watchForUpdate)
        .catch(function () { /* SW unavailable (e.g. insecure origin) */ });

      navigator.serviceWorker.addEventListener("controllerchange", function () {
        // Only reload when an update took over after the user tapped Reload.
        if (hadController) window.location.reload();
      });
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
