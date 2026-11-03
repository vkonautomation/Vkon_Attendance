#!/usr/bin/env python3
"""
Static verification for the PROGRESSIVE WEB APP (installable) conversion.

Covers the request "i need this to be a webapp" with the two agreed decisions:

  1. BOTH surfaces installable  -> the employee portal (index.html) and the admin
     console (admin.html) each carry the manifest link, theme-color, the iOS
     meta tags, an apple-touch-icon, and register the service worker via pwa.js.
  2. Update UX = "Update available - reload" -> the worker installs and WAITS
     (no skipWaiting on install); pwa.js shows a Reload toast and only swaps the
     controller when the user taps it, so a punch is never interrupted.

Crucially it also asserts the safety invariants that keep the PWA from breaking
the live sync engine: the service worker must NOT touch /api/* (the punch queue
and state flush in js/api.js drive themselves off failed network requests), the
worker version and the HTML cache-buster must agree, and the manifest must ship
a complete icon set (192 / 512 / maskable / apple-touch).

It is a static check -- it reads the source and asserts the wiring is present --
mirroring the other verify_*.py suites.
"""

import json
import os
import sys


def read_pub(name):
    with open("public/" + name, "r", encoding="utf-8") as f:
        return f.read()


def pub_path(name):
    return os.path.join("public", *name.split("/"))


def verify_all():
    print("=== VERIFYING PROGRESSIVE WEB APP (INSTALLABLE) CONVERSION ===")

    results = []

    def need(cond, msg):
        assert cond, "Fail: " + msg
        results.append("PASS: " + msg)

    index_html = read_pub("index.html")
    admin_html = read_pub("admin.html")
    sw = read_pub("sw.js")
    pwa = read_pub("js/pwa.js")

    # ---- 1. manifest is present, parsed, and complete ---------------------
    print("\n[1] Web app manifest:")
    need(pub_path("manifest.webmanifest") and os.path.exists(pub_path("manifest.webmanifest")),
         "public/manifest.webmanifest exists")
    manifest = json.loads(read_pub("manifest.webmanifest"))
    need(manifest.get("name") and manifest.get("short_name"),
         "manifest has name + short_name")
    need(manifest.get("start_url") == "/index.html" and manifest.get("id") == "/index.html",
         "manifest start_url/id point at the employee portal")
    need(manifest.get("scope") == "/",
         "manifest scope is '/' so the admin console is inside scope too")
    need(manifest.get("display") == "standalone",
         "manifest display is standalone (installs as an app)")
    need(manifest.get("theme_color") == "#ea580c" and manifest.get("background_color") == "#ffffff",
         "manifest theme/background match the VKON brand palette")
    icon_srcs = {i.get("src") for i in manifest.get("icons", [])}
    purposes = {i.get("purpose") for i in manifest.get("icons", [])}
    need("/assets/icons/icon-192.png" in icon_srcs and "/assets/icons/icon-512.png" in icon_srcs,
         "manifest declares the 192 + 512 'any' icons")
    need(any(p and "maskable" in p for p in purposes),
         "manifest declares a maskable icon")

    # ---- 2. icon files actually exist on disk -----------------------------
    print("\n[2] Icon set present:")
    for rel in ["assets/icons/icon-192.png", "assets/icons/icon-512.png",
                "assets/icons/maskable-512.png", "assets/icons/apple-touch-icon-180.png"]:
        need(os.path.exists(pub_path(rel)), "icon file exists: " + rel)

    # ---- 3. both HTML surfaces are wired identically ----------------------
    print("\n[3] Both surfaces installable:")
    for label, html in [("index.html", index_html), ("admin.html", admin_html)]:
        need('<link rel="manifest" href="/manifest.webmanifest">' in html,
             label + " links the manifest")
        need('<meta name="theme-color" content="#ea580c">' in html,
             label + " sets the theme-color")
        need('rel="apple-touch-icon"' in html,
             label + " has an apple-touch-icon")
        need('name="mobile-web-app-capable"' in html and 'name="apple-mobile-web-app-capable"' in html,
             label + " carries the web-app-capable metas")
        need("js/pwa.js" in html,
             label + " loads js/pwa.js (registers the service worker)")

    # ---- 4. service worker caching cannot break the live sync engine ------
    print("\n[4] Service worker is sync-safe:")
    need('/api/' in sw and 'pathname.startsWith("/api/")' in sw,
         "sw.js leaves /api/* untouched (never cached) so the punch queue keeps working")
    need('if (req.method !== "GET") return;' in sw,
         "sw.js only ever intercepts GET (never a POST/PUT punch)")
    need('req.mode === "navigate"' in sw and "networkFirst" in sw,
         "sw.js serves HTML network-first (fresh shell when online, cached when offline)")
    need('searchParams.has("v")' in sw and "cacheFirst" in sw,
         "sw.js serves versioned assets cache-first (immutable by ?v= URL)")

    # ---- 5. update UX = install-and-wait, reload on user tap --------------
    print("\n[5] 'Update available - reload' flow:")
    install_block = sw.split('addEventListener("install"')[1].split('addEventListener("activate"')[0]
    # The install comment literally mentions skipWaiting; assert no real CALL.
    need("self.skipWaiting()" not in install_block,
         "sw.js install handler does NOT skipWaiting (the new worker waits)")
    need('action === "SKIP_WAITING"' in sw and "self.skipWaiting()" in sw,
         "sw.js only calls skipWaiting when pwa.js posts SKIP_WAITING")
    need('"Update available' in (sw + pwa) or "new version is available" in pwa,
         "pwa.js surfaces an update-available prompt")
    need("SKIP_WAITING" in pwa and "controllerchange" in pwa,
         "pwa.js hands control to the waiting worker only on the user's Reload tap")
    need("hadController" in pwa,
         "pwa.js distinguishes first install from update (no reload loop on install)")

    # ---- 6. registration + offline UX -----------------------------------
    print("\n[6] Registration + offline banner:")
    need('navigator.serviceWorker.register("/sw.js")' in pwa,
         "pwa.js registers /sw.js")
    need("beforeinstallprompt" in pwa and "promptInstall" in pwa,
         "pwa.js captures the install prompt (VKON_PWA.promptInstall)")
    need('addEventListener("offline"' in pwa and 'addEventListener("online"' in pwa,
         "pwa.js shows an offline banner and clears it back online")

    # ---- 7. worker version agrees with the HTML cache-buster --------------
    print("\n[Cache] worker version matches served assets:")
    ver_line = [ln for ln in sw.splitlines() if "const VERSION" in ln]
    need(len(ver_line) == 1 and "20261102_en10" in ver_line[0],
         "sw.js VERSION is pinned to the current token (20261102_en10)")
    need("20261102_en10" in index_html and "20261102_en10" in admin_html,
         "both pages carry the en10 cache-buster")
    need("20261102_en9" not in index_html and "20261102_en9" not in admin_html,
         "no stale en9 token left in either page")

    for r in results:
        print("  " + r)

    print("\n" + "=" * 55)
    print("ALL PROGRESSIVE WEB APP CHECKS PASSED")
    print("=" * 55)


if __name__ == "__main__":
    try:
        verify_all()
    except AssertionError as e:
        print(str(e))
        sys.exit(1)
