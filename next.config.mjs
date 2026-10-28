/**
 * VKON Attendance -- Next.js configuration.
 *
 * The portal is not a React app. index.html / admin.html and their plain scripts
 * are the product, and Next.js is here to serve them from `public/` and to host
 * the API route handlers. Everything below exists to keep that arrangement
 * honest: only browser assets are reachable, documents are never cached, and the
 * Content Security Policy is the one the portal already runs on.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";

// Pinned to this file's directory. Left to itself Next walks up from the project
// looking for a workspace root, and a stray package.json in the developer's home
// directory becomes the root - which then resolves dependencies and lockfiles
// outside the repository. The build must see exactly one project: this one.
const PROJECT_ROOT = path.dirname(fileURLToPath(import.meta.url));

// The CSP below is copied from server/main.py, where it was derived line by line
// from what the two HTML files actually reference. Two details there are easy to
// lose and are load-bearing: cdnjs must appear under font-src as well as
// style-src, or Font Awesome renders as empty boxes; and unpkg is under
// script-src only because leaflet is loaded from it with SRI. tests/probe.mjs
// re-derives the external origins from the HTML and fails if this list and those
// pages ever disagree, which is what makes drift a build failure rather than a
// production outage.
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' https://unpkg.com",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://cdnjs.cloudflare.com https://unpkg.com",
  "font-src 'self' https://fonts.gstatic.com https://cdnjs.cloudflare.com data:",
  "img-src 'self' data: https:",
  "connect-src 'self' https://timeapi.io https://worldtimeapi.org https://nominatim.openstreetmap.org",
  "object-src 'none'",
  "base-uri 'self'",
  "frame-ancestors 'self'",
  "form-action 'self'",
].join("; ");

// 'unsafe-inline' in script-src is deliberate, not laziness: index.html and
// admin.html carry inline onsubmit/onclick handlers throughout, and tightening
// this to a hash or nonce set would break the portal silently on the deploy that
// introduced it. Removing it is a real task for the front end, not a config edit.

const nextConfig = {
  // Only .next/standalone, .next/static and public/ enter the image. `.git`,
  // `db/`, `scripts/`, `server/`, `.env` and the compose files are simply not
  // there, so they cannot be fetched over HTTP by any path or traversal. This is
  // why the fix for the live /.git exposure is a different build rather than a
  // longer deny list.
  //
  // One exception, verified against the build output rather than assumed: Next
  // copies the project's .env into .next/standalone next to server.js so the
  // runtime can load it. Nothing routes to it - /.env is a 404, asserted by
  // tests/probe.mjs - but it is still in the image, so the Dockerfile deletes it
  // and lets the container receive its environment from the orchestrator instead.
  output: "standalone",

  // Default false in Next 16; stated because shipping them would hand the browser
  // a map that reconstructs the server's TypeScript.
  productionBrowserSourceMaps: false,

  poweredByHeader: false,

  reactStrictMode: true,

  turbopack: {
    root: PROJECT_ROOT,
  },

  async rewrites() {
    // beforeFiles, so the rewrite is resolved before Next checks its own routes
    // and public/ serves the file. Without this `/` 404s: there is no app/page.tsx
    // and adding one would put a React shell in front of the real portal.
    return {
      beforeFiles: [
        { source: "/", destination: "/index.html" },
        { source: "/admin", destination: "/admin.html" },
      ],
      afterFiles: [],
      fallback: [],
    };
  },

  async headers() {
    return [
      {
        // The documents are the thing a stale copy actually breaks: a browser
        // holding yesterday's index.html against today's API is how the 422
        // confusion presented. no-store on everything, and the ?v= tokens stop
        // being the only defence.
        source: "/:path*",
        headers: [
          { key: "Content-Security-Policy", value: CSP },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "same-origin" },
          { key: "Cache-Control", value: "no-store" },
        ],
      },
      {
        source: "/api/:path*",
        headers: [
          // Belt and braces for the API specifically. A cached /api/state hands one
          // employee's attendance record to the next person who opens the portal,
          // and a cached Set-Cookie breaks sign-in outright. Cloudflare must also
          // bypass /api/* at the edge; this stops the origin from ever marking a
          // response as cacheable in the first place.
          { key: "Cache-Control", value: "no-store, max-age=0" },
          { key: "Pragma", value: "no-cache" },
        ],
      },
    ];
  },
};

export default nextConfig;
