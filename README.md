# Vkon Attendance System

A comprehensive web-based attendance and verification platform designed to track employee check-ins, manage administrative workflows, and verify daily attendance logs in real time.

---

## 📁 Project Structure

Next.js owns the process: it serves the portal out of `public/` and hosts the API
under `app/api/*`. `output: "standalone"` means the deployable is one directory,
so nothing outside `public/` can be fetched over HTTP at all — the fix for the
repository being web-served is a different build, not a longer deny list.

* **`public/` — everything the browser can reach, and nothing else:**
  * `index.html` / `admin.html`: the employee portal and the admin console.
  * `shared.js`: the attendance rule engine (day status, LOP, quotas, alerts).
  * `app.js` / `admin.js`: page logic for the portal and the console.
  * `styles.css`: presentation.
  * `js/`: the server adapter (`api.js`), password flows, day popover, approval
    modal, data transfer. `assets/`: logos and icons.
* **`app/api/` — the server:** route handlers only, no pages. `health`, the
  `auth/*` vertical slice (login, logout, me, password, sessions) and `punches` are live.
  Auth is hardened (M4: two-bucket rate limiting on sign-in, an Origin check on every
  non-GET, body-size ceilings, generic errors); `POST /api/punches` (M6) is idempotent on
  the queue's key, draws the geofence verdict server-side from the stored fix, and closes
  an unfinished prior day on a new check-in. The `/state` document facade is deliberately
  not shipped yet — see the note below — so the portal still hydrates from `public/`.
* **`lib/`** — `config.ts` reads and validates the environment once; `db/` is the
  app-role pool and the append-only audit writer; `auth/` is bcrypt, the session
  table, the cookie and the sign-in rate limiter; `http/` is `requireSession()`, the one
  error shape, the request body reader and the same-origin guard; `rules/` is the
  attendance engine as pure TypeScript functions (day status, whole-day LOP, payroll
  cut-off, declared-vs-restricted holidays, WFH-per-week, quotas, alerts) that take
  their inputs as arguments and read no store, so route handlers can import them
  directly and the browser and the server are held to the same arithmetic; `geofence.ts`
  is the server-side presence verdict (haversine mirroring `shared.js`, fail-closed on an
  unusable fix). `punches.ts` is the punch command/projection (one row per employee per IST
  day) and `state/settings.ts` reads the fence radius and accuracy gate from the `settings`
  table so a policy change re-decides history, not only new punches.
* **`server/`** — the outgoing FastAPI backend, still the thing production runs
  until the Next.js one is verified. It reads the same `public/` directory.
* **`scripts/`** — `start-standalone.mjs` assembles and runs the deployable
  payload; `run-tests.mjs` is the whole suite in one command; `db-setup.mjs`
  creates the application role, `db-migrate.mjs` applies `db/migrations/*.sql`
  and `db-seed.mjs` loads the synthetic development data.
* **`db/migrations/`** — the schema, as ordered SQL. One transaction per file, and
  `schema_migrations` records the checksum of the file that applied each one.
* **`db/seed/synthetic.sql`** — a roster of `EMP001`…`EMP005` and `@example.test`
  addresses, idempotent, and refused outright when `VKON_ENV=production`. It sets no
  password for anyone; in development `db-seed.mjs` then bootstraps the one `admin`
  account with a freshly generated password, printed once and forced to change on first
  sign-in (never committed — the hash is made at runtime). Real
  people are loaded on the deploy host, never committed here: this repository is
  public and `tests/guard.mjs` fails the build if anything looks like real data.
* **`deploy/compose.yml`** — PostgreSQL on its own network and volume, publishing
  no port. `deploy/compose.dev.yml` adds a loopback listener for a laptop, and is
  kept separate so it cannot be applied to production by accident.
* **`tests/`** — `guard.mjs` is the public-repository check, and tests itself so it
  cannot pass by being blind; `probe.mjs` asserts the shape of the running server
  (which URLs answer, which headers are set, what must stay unreachable);
  `unit/` holds the pure loader tests; `conformance/conformance.spec.ts` loads `public/shared.js`
  for real in a `node:vm` and runs the same JSON fixtures in `tests/fixtures/` against it and
  against `lib/rules/`, failing on any divergence — the check that keeps one source of truth
  from quietly becoming two while both sides are still live (M5); `integration/db.mjs` asserts the roles, the
  runner, every schema constraint and the network; `integration/auth.mjs` drives the
  sign-in flow over HTTP against the served payload (equal-time unknown user, no
  enumeration, mid-session deactivation, expiry, password change revoking other sessions);
  `integration/hardening.mjs` drives the M4 controls against a second instance started
  with `PUBLIC_ORIGIN` and the real rate limit (a 6th attempt on one account is 429 while
  a different account signs in, a foreign or absent `Origin` is 403 while the correct one
  succeeds, a second address is untouched by the first's lockout, an oversized body is 413);
  `integration/punches.mjs` drives the M6 slice over HTTP against the served payload and the
  real `records` table (a replayed flush leaves one row; a fix coarser than the trust limit
  is refused by the fence but still recorded as evidence; a tab left open past midnight
  yields yesterday's close at the boundary and today's open; a non-admin cannot punch for
  another and an anonymous punch is 401).
* **Verification and testing scripts** (`test_*.js`, `verify_*.py`,
  `test_backend.py`) sit at the repository root and load the portal from
  `public/`; `node scripts/run-tests.mjs` runs all of them.

> **Why `/state` is not shipped yet (M6 note).** The portal's document seam (D1) writes
> whole `vkon_*` documents via `PUT /api/state/{key}` and hydrates from `GET /api/state`.
> `js/api.js` decides server-vs-local mode from that `GET`, and once it succeeds every
> subsequent edit is a `PUT` — a `GET` without a matching, lossless `PUT` puts a live user
> into an endless retry loop. A partial facade is therefore worse than none: it would
> violate the one standing requirement that the existing front end keeps working. The
> relational schema behind it is complete (`records`, leaves, wfh, holidays, settings and
> the rest all exist), but assembling *and* accepting every browser document without loss is
> the document-facade work that completes with the data milestones, not the punch slice. So
> M6 lands punches as a per-entity endpoint (the offline queue's real target) and leaves
> `/state` unshipped; the portal keeps hydrating from `public/` exactly as it did before.

A development database from nothing:

```bash
npm run db:up && npm run db:prepare   # setup, migrate, seed
npm run test                          # guard, unit, 11 Node suites, conformance, Python, db, auth, punches, hardening, probe
```

---

## 🚀 Installation Instructions

Follow these steps to set up the project locally for development and testing:

1. **Clone the Repository:**
   ```bash
   git clone [https://github.com/your-username/your-attendance-repo.git](https://github.com/your-username/your-attendance-repo.git)
   cd ATTENDANCE
