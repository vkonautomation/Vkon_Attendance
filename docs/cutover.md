# VKON Attendance -- production cut-over runbook (M12)

This is the runbook for putting the Next.js backend in front of
`attendance.vkon.in`, and for undoing the deploy that is currently failing. Read
**Part A** first if the site is down; it is the emergency action. **Part B** is the
planned cut-over and needs host access, the Cloudflare Tunnel, and the real roster —
none of which are available from the repository alone.

## Why the last deploy failed

`attendance.vkon.in` is served by **nginx over the git working tree**: the deploy is a
`git merge --ff-only` on the host and nginx's document root is the repository root.
That is why `/.git/logs/HEAD` and `/server/main.py` have been reachable by URL — the
exposure `docs/backend.md` calls out.

Milestone M0 moved the browser entry points (`index.html`, `admin.html`, `shared.js`,
…) out of the repository root and into `public/`, so that "what is web-reachable"
becomes a directory boundary the Next build enforces instead of a list nginx has to
remember. The consequence for the *old* serving model is immediate: once `index.html`
is no longer at the working-tree root, a request to `/` resolves a directory with no
index file and no autoindex, and **nginx answers `403 Forbidden`**. The deploy panel's
post-deploy check hits `GET http://127.0.0.1:8135/`, saw the 403, retried for 90s, and
failed the release. The health check did its job; the restructure simply must not reach
production until the thing serving it changes too.

```
079433e  index.html at the repo root      -> / serves 200   (last good)
c168594  index.html only under public/    -> / serves 403   (this deploy)
```

---

## Part A — Restore service now (rollback)

Do this from the deploy panel. It does not need host shell access and it is reversible.

1. **Roll the release back to `079433e`** (the panel's previous-good tag). That puts
   `index.html` back at the working-tree root and clears the 403 within seconds.
2. **Confirm recovery:**
   ```
   curl -sS -o /dev/null -w '%{http_code}\n' https://attendance.vkon.in/      # 200
   curl -sS -o /dev/null -w '%{http_code}\n' https://attendance.vkon.in/admin  # 200
   ```
3. **Stop re-deploying forward** until Part B is applied. Merging any commit at or
   after M0 to this host reproduces the 403, because the host still serves the repo
   root. This is the reason M6/M7 were never pushed: they are green locally but the
   serving model they assume is not live yet.

> The rollback returns the site to the **pure-static** behaviour it had before the
> backend existed: each browser keeps its own `localStorage`, no shared data, and the
> `/.git` exposure remains open. That is the accepted status quo until the cut-over.

---

## Part B — The cut-over (needs host access)

This replaces "nginx serves the git working tree" with "the tunnel serves a Next.js
container." It closes the `/.git` and `/server` exposure as a side effect, because the
container image contains neither.

### Prerequisites (all must be true before starting)

- [ ] **Host shell access** to the deploy box (to stop nginx, run compose, run migrations).
- [ ] **The Cloudflare Tunnel** for `attendance.vkon.in`. The ingress service URL lives
      in the Cloudflare dashboard and may not be editable from the host; on the current
      box the tunnel reaches the **nginx container** by container DNS on port 80 of the
      `vkon_attendance_default` bridge (confirmed from nginx access logs), so nginx must
      stay the tunnel endpoint and be repurposed as a reverse proxy rather than replaced
      on `127.0.0.1:8135`.
- [ ] **Postgres up** and the **application role created** (`npm run db:setup`), with
      `DATABASE_URL_APP` and `DATABASE_URL_OWNER` in the host `.env`.
- [ ] **The real roster and policy numbers** loaded (see "Load real data" below). The
      synthetic seed is refused when `VKON_ENV=production`, so nothing real exists until
      this step is done deliberately on the host.
- [ ] **`BCRYPT_COST_FACTOR` measured on this host** (`npm run bcrypt:calibrate`); 11 is
      the assumed 1-CPU default, not a verified number for this machine.
- [ ] **`.env` set** with `PUBLIC_ORIGIN=https://attendance.vkon.in`,
      `VKON_TRUST_PROXY_HEADERS=true`, `COOKIE_SECURE=true`, `APP_PORT=8135`.

### The `/api/state` gap is now closed (update: shipped in `c450987`)

The shared-state document API **is shipped**: `GET /api/state` projects the `vkon_*`
documents from the `state_documents` table (migration `0008`) and `PUT /api/state/{key}`
writes them back with per-key optimistic concurrency and a role-based write policy.
That means the D1 document facade — not just auth and punches — lands with this
cut-over, so a signed-in browser hydrates **shared** state instead of falling through
to `local` mode. Trace `public/js/api.js` `boot()`:

- `/api/health` 404 → `local` mode (the old static behaviour). After the cut-over it
  returns 200, so the login screen offers **real password auth** and `hydrate()` runs.
- `hydrate()` → `GET /api/state` now returns 200 with the shared documents; the browser
  enters shared mode and its writes go to the server via `PUT /api/state/{key}`.

What remains is the **per-entity migration** (M8–M11: rules computed server-side, the
document facade retired key by key). That is integrity/hardening work, **not** required
for a functional shared launch. The one true prerequisite the repository cannot supply
is **real people in the `employees` table** — see step 3 — because sign-in is checked
against it and production refuses to seed synthetic staff.

### Ordered steps

Run from the host checkout, in this order. Each step is safe to stop at.

1. **Merge the code forward** to the cut-over commit (the one that adds `Dockerfile.app`
   and the `app` service). Because nginx is still on `8135` at this moment, `/` will 403
   until step 5 — that is expected and only lasts for the rest of this procedure.
   ```
   git fetch origin && git merge --ff-only origin/main
   ```
2. **Migrate the schema as the owner** (the app container cannot; it has no `CREATE`):
   ```
   npm ci
   npm run db:setup && npm run db:migrate
   ```
3. **Load real data** — the live roster and the signed-off policy numbers, into the
   `employees` / `settings` tables. This is the HR-owned step; the repository never
   holds it. Create the first administrator with **`npm run db:admin`**
   (`scripts/db-bootstrap-admin.mjs`): set `VKON_ADMIN_PASSWORD` in the host `.env` for a
   chosen password with **no** forced change, or leave it blank for a one-time password
   that forces a change on first sign-in. It refuses to reset an existing admin, so it is
   safe to re-run. Grow the rest of the roster through the admin console (M7).
4. **Build and start the app + database containers** (compose template is
   `deploy/compose.yml`; the host applies it to its own untracked `docker-compose.yml`):
   ```
   docker compose -f deploy/compose.yml --env-file .env up -d --build db app
   docker compose -f deploy/compose.yml ps         # app should be healthy
   ```
5. **Release port 8135 from nginx and hand it to the container.** Stop/disable the
   nginx site that roots at the working tree *before* the container binds 8135, or the
   container will fail to take the port:
   ```
   sudo systemctl stop nginx && sudo systemctl disable nginx   # or: nginx -s stop + remove the site
   docker compose -f deploy/compose.yml up -d app              # now binds 127.0.0.1:8135
   curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8135/    # 200
   ```
6. **Cloudflare cache bypass for `/api/*`.** The origin already sends
   `Cache-Control: no-store` on `/api/*` (`next.config.mjs`), but add a page rule /
   cache rule at the edge to **bypass cache for `attendance.vkon.in/api/*`** so a cached
   `Set-Cookie` or one employee's `/api/state` can never be served to the next visitor.
7. **Verify against production** (see next section). Only after every check passes,
   re-enable any monitoring/backup hooks that assumed the old layout.

### Verify

`tests/probe.mjs` runs against any live URL and is the exact contract the container must
satisfy — it asserts `/` and `/admin.html` serve, `/api/health` is 200, and that
`/.git/logs/HEAD`, `/server/main.py`, `/.env` and path traversals are **not** reachable.

```
PROBE_BASE_URL=https://attendance.vkon.in node tests/probe.mjs     # all PASS

curl -sS https://attendance.vkon.in/api/health                     # {"status":"ok"...}
curl -sS -o /dev/null -w '%{http_code}\n' https://attendance.vkon.in/.git/config   # 404 (was reachable)
curl -sS -o /dev/null -w '%{http_code}\n' https://attendance.vkon.in/server/main.py # 404
```

Then sign in as the bootstrap admin in a browser, confirm the session cookie is
`Secure` + `HttpOnly`, and confirm a wrong origin POST to `/api/...` is refused `403`.

### Rollback (if the cut-over misbehaves)

The container is disposable and the database volume is not, so rollback is a serving
change, not a data change:

```
docker compose -f deploy/compose.yml stop app
sudo systemctl enable --now nginx          # working tree is still on disk at the merged commit
```

If the merged code's missing root `index.html` is the problem nginx reintroduces, roll
the checkout back to `079433e` (`git reset --hard 079433e`) exactly as in Part A. The
`attendance-pgdata` volume is untouched by either action, so no attendance data is lost
by backing the serving change out.

### Executed procedure (2026-10-29, host `ptz`) — what actually ran

The steps above were executed with two differences forced by the real topology (the
tunnel endpoint must remain the nginx container) and by the host's node v12 (too old to
build Next; the build cannot run on the host at all):

1. Repo ff-merged to the cut-over commit; schema already at migration `0008` with the
   `attendance_app` role present (`db:setup`/`db:migrate` had been run earlier).
2. **Build in RAM**: `docker run node:20-alpine` with `--tmpfs /work:size=4g,exec`
   mounting the checkout `:ro`; `npm ci` (fresh musl binaries — the host's
   `node_modules` is glibc) then `node node_modules/next/dist/bin/next build`; the
   standalone output (`.next/standalone/.` + `.next/static` + `public`) assembled into
   `/home/ptz/project2/vkon-next-app`, with no `.env` copied into it.
3. **App container**: `docker run -d --name attendance-app --network
   vkon_attendance_default --network-alias attendance-app -v
   /home/ptz/project2/vkon-next-app:/app -w /app --env-file <app-only keys> -e
   NODE_ENV=production -e PORT=8000 -e HOSTNAME=0.0.0.0 --restart unless-stopped
   node:20-alpine node server.js`, then `docker network connect attendance-internal
   attendance-app` so `DATABASE_URL_APP` resolves `db:5432`. The env file is built by
   grepping ONLY the app-role keys (`VKON_ENV`, `PUBLIC_ORIGIN`, `COOKIE_SECURE`,
   `VKON_TRUST_PROXY_HEADERS`, `DATABASE_URL_APP`, `BCRYPT_COST_FACTOR`, session and
   rate-limit knobs) out of `.env` — the owner URL and tunnel token never enter the
   app container. No host port is published.
4. **nginx flip (the cut-over itself)**: `proxy.conf` written to
   `/home/ptz/project2/vkon-nginx/` — `location / { proxy_pass
   http://attendance-app:8000; ... }` passing `Host`, `X-Forwarded-For`,
   `X-Forwarded-Proto`, `X-Real-IP` and `CF-Connecting-IP` through — mounted over
   `/etc/nginx/conf.d/default.conf` in the host `docker-compose.yml` (timestamped
   backup of the compose file taken first; the `./public` mount is left in place).
   `docker compose up -d app` recreates nginx as a pure reverse proxy; every response
   including headers and rewrites now comes from Next, so nginx adds no rules of its
   own.
5. **First administrator**: `docker run --rm --network host -v <repo>:/app -w /app
   node:20-alpine node scripts/db-bootstrap-admin.mjs` — host networking because
   `DATABASE_URL_OWNER` points at `127.0.0.1:5433`. `VKON_ADMIN_PASSWORD` was blank,
   so a one-time password was minted, printed once, and `password_change_required`
   was set per owner policy. Re-running is inert (existing account untouched).
6. **Verify**: `PROBE_BASE_URL=https://attendance.vkon.in node tests/probe.mjs` from a
   `node:20-alpine --network host` container against the live domain → **144/144**;
   `/api/health` returns `{"status":"ok","api":"v1"}`; `/.git/config`, `/.env`,
   `/server/main.py` → 404; OTP login → 200 with `mustChangePassword: true`, and
   `GET /api/state` under that session correctly returns **403 until the password is
   changed** (`requireSession` gates every API on the forced change).

Rollback for this topology: restore the timestamped compose backup and
`docker compose -f docker-compose.yml --env-file .env up -d --force-recreate app` —
nginx serves `./public` statically again in seconds. The `attendance-app` container can
stay running harmlessly (it publishes no host port); remove it with
`docker rm -f attendance-app` once the old serving model is confirmed healthy.

**`BCRYPT_COST_FACTOR=12` is a host-measured number** (`bcrypt:calibrate` run on `ptz`),
not the assumed 1-CPU default. The Cloudflare `/api/*` cache bypass (step 6 of the
Ordered list) remains a dashboard action; the origin's `Cache-Control: no-store` on
`/api/*` is verified live and carried through the proxy.

---

## Blocking items (why this is not done from the repo)

Status after the 2026-10-29 execution (see "Executed procedure" above): items 1 and 2
were cleared on the host; the `/state` decision in item 4 is moot because the facade
shipped in `c450987` and is live.

1. **Host access** — required to run the build, the containers, the owner scripts and
   the nginx flip. Done on `ptz`; re-run from the same place after each release.
2. **Tunnel/cache control** — the cut-over works *with* the tunnel as it is (nginx
   stays the endpoint), but the `/api/*` edge cache bypass remains a Cloudflare
   dashboard action.
3. **Real roster + policy numbers are owner-owned** — deliberately never committed. The
   production DB holds only the bootstrap admin; real people arrive either by the
   owner signing in (the browser's `adoptLocalState()` migrates its own `vkon_*`
   documents on first sign-in) or by `npm run db:import` against the real Export file
   once its fields are confirmed.
