# VKON Attendance backend

The portal was a static site: every person's browser held its own copy of the data
in `localStorage`, so an approval given on one laptop did not exist on another. This
backend makes the data shared, and keeps the static behaviour as the fallback.

## What it is

FastAPI + SQLite, serving the API **and** the front end from one container on one
origin. No CORS, no bearer token in `localStorage`, and the session is an `httpOnly`
signed cookie.

| Path | Purpose |
| --- | --- |
| `GET /api/health` | Public liveness. The browser probes this to decide its mode. |
| `POST /api/auth/login` | bcrypt verify, issue session. Rate limited per account **and** per source. |
| `POST /api/auth/logout`, `POST /api/auth/password` | End session; change password. |
| `GET /api/auth/me` | Who the cookie belongs to. |
| `GET /api/state` | Every store document with its version, in one round trip. |
| `PUT /api/state/{key}` | Versioned write. Stale base version → `409` carrying the current value. |
| `POST /api/punches`, `GET /api/punches` | Server-clock punch evidence. Idempotent on `punchId`. |
| `GET /api/audit` | Admin-only trail of logins, writes, rejections and punches. |

Runtime dependencies are `fastapi`, `uvicorn`, `sqlalchemy`, `bcrypt`,
`itsdangerous`, `pydantic`. That is the whole list, on purpose: the target is a
low-end Android phone on a rural connection, so there is no build toolchain, no ORM
migration framework and one container to operate.

## How the front end fits

`js/api.js` loads before `shared.js`. It hydrates an in-memory copy of the shared
state, and `getStore()`/`setStore()` in `shared.js` read and write through it.

- **`getStore` stays synchronous.** The ~190 call sites in a 22,000-line front end
  did not have to change, because the adapter answers from memory.
- **`setStore` writes twice**: immediately to `localStorage`, then debounced to the
  server. `localStorage` is a shadow copy, so the portal still works with the network
  unplugged, on a train, or on a static-only host.
- **A conflict is adopted, never overwritten.** If a colleague saved the same
  document first, their version wins, this tab is told on screen, and the user redoes
  the edit. Silent last-writer-wins is how an approval workflow loses decisions.
- **Punches are local-first.** `VKON_API.punch()` queues the punch on the device and
  replays it when a connection appears; the server stamps its own clock and re-checks
  the geofence. Nobody at a gate is told "punch failed" because the signal dropped.
- **Mode is decided before first render.** Both consoles wait on `VKON_API.ready`.
  Booting earlier would paint yesterday's cached copy as though it were current.
- **"A server exists" is not "I may write to it".** The write path stays shut until a
  session is verified. Without that gate, an anonymous visitor opening the login
  screen has `shared.js` seed its demo defaults, every one of which is then pushed
  at the server, refused with a 401, re-dirtied and pushed again - which is how the
  untouched login page came to issue 650 requests in three minutes during the first
  live run. A 401 now closes the write path instead of retrying it.
- **Retries back off.** A dropped connection re-queues the edit and doubles the wait
  up to 30 seconds. A punch screen on one bar of signal must not also be a loop.

If `/api/health` 404s, the browser is on a static host and everything above is
inert: the portal behaves exactly as it did before the backend existed. The one
visible trace is a single 404 in the console for that probe, which is unavoidable -
the probe is how the page learns there is no server.

Both states announce themselves. The badge in the login card reads
"Attendance server - sign in required" or "Demo mode - not authenticated", and the
one-tap identity chips are hidden whenever a real server is authenticating. The
badge is worded for where it sits: it is only ever visible *before* sign-in, so it
describes who is in charge of authentication rather than claiming a sign-in that has
not happened.

## Running it locally

```
py -m venv .venv
.venv\Scripts\python -m pip install -r requirements.txt
.venv\Scripts\python -m uvicorn server.main:app --port 8131
```

With no `.env` it runs in `development`: a generated session key, a database at
`./data/vkon.db`, and the admin password taken from `VKON_ADMIN_PASSWORD` or
generated. Tests: `.venv\Scripts\python -m pytest test_backend.py -q`.

The Content-Security-Policy names every external origin the two HTML files load -
`cdnjs.cloudflare.com` for Font Awesome and its glyph files, `unpkg.com` for
Leaflet's map in the admin console, `fonts.googleapis.com`/`fonts.gstatic.com` for
type. `test_backend.py` reads those origins out of `index.html` and `admin.html` and
asserts the header allows each, because the first version of this server blocked the
icons and the map completely while every backend test stayed green.

## Deploying

`docker compose up -d` still serves the static build. The backend is behind a
profile, so switching is deliberate:

```
python -c "import secrets; print(secrets.token_urlsafe(48))"   # put in .env as SESSION_SECRET
docker compose --profile backend up -d --build
```

The backend publishes `127.0.0.1:8131` only. Point the public host at it instead of
the static container's `8130`, then stop the static service if you want one writer.
Behind a Cloudflare Tunnel or a reverse proxy that rewrites the client address, set
`VKON_TRUST_PROXY_HEADERS=true` so rate limiting reads `cf-connecting-ip` rather than
counting every visitor as the tunnel.

`VKON_ENV=production` is baked into the image, and the app **refuses to start** with
an empty `SESSION_SECRET`. That is intentional: an ephemeral key would silently log
everyone out on each restart and hide the fact that no secret was ever installed.

## Accounts and first sign-in

There is no default password anywhere in this repository or in the image.

- **Administrator.** Uses `VKON_ADMIN_PASSWORD` if it is strong enough. Otherwise one
  is generated, written to `data/initial-credentials.txt` (owner-only), and reported
  once at boot. Retrieve it, hand it out, delete the file.
- **Employees.** Publishing the roster (`vkon_employees_v6`) provisions an account for
  every row that lacks one, with a generated temporary password in the same file and
  `must_change_password` set. The app then forces the change on first sign-in — the
  server refuses every data request until it is done.
- Existing accounts are never reset by a roster edit. Their password, role and lock
  state are theirs.

## Boundaries of phase 1

**The attendance day is still computed by `shared.js`.** The server stores the record
documents and the punch evidence; it does not yet derive Present/Absent/LOP/WFH from
that evidence. Making it do so would put two writers on every day, and the client's
day arithmetic is already covered by the test suite. Moving that verdict server-side is
the next step, and it should only happen once the punch events are complete enough to
rebuild history from.

Write authority (`server/policy.py`) is what makes this a server rather than a shared
hard drive: an employee may only touch their own record, cannot approve their own
request, cannot delete a decided one, and cannot publish the roster. A manager may act
only on their own direct reports.

## SQLite is fine until it is not

One punch per person per check-in, a few hundred people: SQLite on a named volume is
the right amount of machinery, and it keeps the stack to one container with one file
to back up. Move to Postgres when you hit any of these:

- Two or more app containers writing at once (a second writer wants a real server).
- Reporting that scans months of history while people are punching in.
- Attendance data becoming an input to payroll that cannot tolerate a lost write.

`database_url` is the only seam; the models are plain SQLAlchemy, and
`test_backend.py` does not assume a file behind them.

## What the backend does not do

It does not make the old static deployment secure. `attendance.vkon.in` served from
the git working tree through nginx still exposes `/.git/*`, and the credentials burned
into the repository's history (`admin123`, and the TOTP secret) stay burned — treat
them as public, and rotate anything still in use. Do not point the public host at this
backend until the tunnel or proxy in front of it is the only way in.
