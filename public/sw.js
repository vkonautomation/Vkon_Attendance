/*
 * VKON Attendance service worker.
 *
 * Caching rules, chosen so the PWA can launch offline WITHOUT ever interfering
 * with the live sync engine (the punch queue and state flush in js/api.js):
 *
 *   - /api/*  -> NOT touched at all. Every GET/POST/PUT goes straight to the
 *     network. The portal must never serve attendance data from a cache, and a
 *     failed request is what drives the device-side punch queue.
 *   - HTML    -> network-first, cache fallback. Online you always get the fresh
 *     page (which points at the current ?v= token); offline you get the last shell.
 *   - Versioned static (?v=...) -> cache-first. Each deploy is a new URL, so a
 *     cached copy can never be stale -- the classic "SW strands you on old JS" bug
 *     cannot happen here.
 *   - Everything else same-origin -> network-first with cache fallback.
 *
 * Updates: a new worker installs and WAITs (no skipWaiting here). js/pwa.js shows
 * an "Update available - reload" toast and only calls skipWaiting when the user
 * taps it, so nobody is swapped mid-punch.
 */

const VERSION = "20261102_en21";
const SHELL_CACHE = "vkon-shell-" + VERSION;
const RUNTIME_CACHE = "vkon-runtime-" + VERSION;

// Small, stable core so the app shell exists even before the first online load.
const SHELL_CORE = [
  "/index.html",
  "/admin.html",
  "/manifest.webmanifest",
  "/assets/icons/icon-192.png",
  "/assets/icons/icon-512.png",
  "/assets/icons/maskable-512.png",
  "/assets/icons/apple-touch-icon-180.png",
  "/assets/vkon-favicon.png"
];

self.addEventListener("install", (event) => {
  // Cache each item independently; one failure must not abort the whole install.
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) =>
      Promise.all(
        SHELL_CORE.map((url) =>
          cache.add(new Request(url, { cache: "reload" })).catch(() => { /* non-fatal */ })
        )
      )
    )
  );
  // Intentionally NOT calling skipWaiting(): the new worker waits for the user.
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((k) => k !== SHELL_CACHE && k !== RUNTIME_CACHE)
          .map((k) => caches.delete(k))
      );
      await self.clients.claim();
    })()
  );
});

// js/pwa.js posts this only after the user taps "Reload".
self.addEventListener("message", (event) => {
  if (event.data && event.data.action === "SKIP_WAITING") self.skipWaiting();
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return; // never intercept a punch/POST/PUT

  const url = new URL(req.url);

  // Only ever manage SAME-ORIGIN requests. Third-party assets (Font Awesome on
  // cdnjs, Google Fonts, unpkg/Leaflet, remote images) go straight to the browser.
  // Intercepting them here meant their opaque cross-origin responses could never
  // be cached, and a failed re-fetch was rethrown -- which blanked the login field
  // icons and the eye button. The browser loads them natively and correctly.
  if (url.origin !== self.location.origin) return;

  // Rule 1: leave the API entirely to the browser + the app's own offline queue.
  if (url.pathname.startsWith("/api/")) return;

  // Rule 2: HTML / navigations -> network-first with cache fallback.
  if (req.mode === "navigate" || url.pathname === "/" || url.pathname.endsWith(".html")) {
    event.respondWith(networkFirst(req));
    return;
  }

  // Rule 3: versioned asset -> cache-first (immutable by URL).
  if (url.searchParams.has("v")) {
    event.respondWith(cacheFirst(req));
    return;
  }

  // Rule 4: everything else same-origin -> network-first with cache fallback.
  event.respondWith(networkFirst(req));
});

async function cacheFirst(req) {
  const cache = await caches.open(RUNTIME_CACHE);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res && (res.ok || res.type === "opaque")) cache.put(req, res.clone());
  return res;
}

async function networkFirst(req) {
  const cache = await caches.open(RUNTIME_CACHE);
  try {
    const res = await fetch(req);
    if (res && res.ok) cache.put(req, res.clone());
    return res;
  } catch (err) {
    const hit = await cache.match(req);
    if (hit) return hit;
    if (req.mode === "navigate") {
      const fallback = (await cache.match("/index.html")) || (await caches.open(SHELL_CACHE).then((c) => c.match("/index.html")));
      if (fallback) return fallback;
    }
    throw err;
  }
}
