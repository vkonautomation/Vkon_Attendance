# Vkon Attendance System

A comprehensive web-based attendance and verification platform designed to track employee check-ins, manage administrative workflows, and verify daily attendance logs in real time.

---

## 📁 Project Structure

The repository contains the following core components:

* **Frontend & Pages:**
  * `index.html`: Main user-facing check-in and dashboard interface[cite: 2].
  * `admin.html`: Administrative control panel for managing records[cite: 2].
  * `styles.css`: Core styling and layout sheets[cite: 2].
  * `app.js` & `admin.js`: Frontend logic for user and admin actions[cite: 2].
  * `shared.js`: Shared utility functions across pages[cite: 2].
* **Verification & Testing Scripts:**
  * `verify_present_day_and_all.py`: Validates present day attendance logs and records[cite: 2].
  * `verify_checkin_and_login.py`: Handles check-in and authentication verification[cite: 2].
  * `verify_ist_clock_and_time.py`: Ensures accurate Indian Standard Time (IST) clock synchronization[cite: 2].
  * `test_all_8_requirements.py` & `verify_requirements.py`: Automated testing suites for core system requirements[cite: 2].
  * Additional feature verification scripts (`verify_three_new_features.py`, `verify_new_4_requests.py`)[cite: 2].
* **Assets:**
  * Logos and iconography (`vkon-logo.svg`, `vkon-logo-light.png`, `vkon-logo-dark.png`, `vkon-icon.svg`)[cite: 2].

---

## 🚀 Installation Instructions

> **Important — this is no longer a pure static site.** The portal now runs on a
> FastAPI + SQLite backend that owns authentication and permissions. It must be
> served by the container (`uvicorn`), not by a static file host (`python -m http.server`).

Follow these steps to set up the project locally for development and testing:

1. **Clone the Repository:**
   ```bash
   git clone https://github.com/vkonautomation/Vkon_Attendance.git
   cd ATTENDANCE
   ```

2. **Run with Docker (recommended):**
   ```bash
   docker compose up --build
   # open http://localhost:8130
   ```

3. **Run locally without Docker:**
   ```bash
   python -m pip install -r requirements.txt
   uvicorn server.main:app --reload --port 8130
   # open http://localhost:8130
   ```

---

## 🔐 Backend, Security & Deployment

### What the backend does
- **Server-side authentication** with bcrypt-hashed credentials (the plaintext demo
  passwords below are only for the seeded dev accounts).
- **Multi-factor authentication (TOTP, RFC 6238) for administrators.** Employees
  sign in with a password only; admins must also enter a 6-digit authenticator code.
- **Login rate limiting** (per-IP) and **per-account lockout** after repeated failures.
- **Secure sessions**: an `HttpOnly`, `SameSite=Lax` session cookie; the server stores
  only a hash of the token. Sessions slide on a 30-minute idle window with a 12-hour cap.
- **Role & ownership permission enforcement on every read/write.** Employees see and
  can only modify their own records/leaves/WFH/regularisations; roster, holidays,
  quotas, settings and other employees' data are admin-only (the backend returns 403).

The existing frontend keeps working through a thin cache adapter
(`js/server-client.js` + the `getStore`/`setStore` seam in `shared.js`). The browser
cache is re-hydrated from `GET /api/state` after sign-in, and writes are mirrored to
`PATCH /api/state/{key}`; the server is authoritative and rejects unauthorized writes.

### Default demo accounts (dev seed — change for production)
| Role | Sign in with | Password | MFA |
|------|--------------|----------|-----|
| Employee | `mukesh` / `EMP001` / `mukesh.sharma@vkon.in` | `mukesh123` | No |
| Employee | `priya` / `priya.patel@vkon.in` | `priya123` | No |
| Employee | `chiranth` / `chiranth.gowda@vkon.in` | `chiranth123` | No |
| Employee | `alex` / `alex.chen@vkon.in` | `alex123` | No |
| Admin | `admin` / `admin@vkon.in` | `admin123` | Yes (TOTP) |

The login field accepts an **Employee ID or Work Email** (or username).

### MFA enrollment for the admin
1. Sign in to the Admin Console and finish the TOTP step.
2. Open **Admin Security → Two-Factor Authentication (MFA)** and reveal the
   enrollment secret / `otpauth` URI, then add it to your authenticator app.
   (The seeded dev secret for quick testing is `JBSWY3DPEHPK3PXP`.)

### Environment variables
Copy `.env.example` to `.env` and adjust. Key values (see the file for the full list):

| Variable | Purpose | Production |
|----------|---------|------------|
| `SESSION_SECRET` | Signs short-lived MFA pre-auth tokens | Set a long random string |
| `VKON_ENV` | `dev` or `prod` | `prod` |
| `COOKIE_SECURE` | Adds `Secure` to the session cookie | `true` **behind TLS** |
| `SESSION_IDLE_SECONDS` / `SESSION_ABSOLUTE_SECONDS` | Session lifetime | as needed |
| `LOGIN_IP_MAX` / `LOGIN_ID_MAX_FAILURES` / `LOGIN_LOCKOUT_SECONDS` | Throttling/lockout | as needed |
| `VKON_DB_PATH` | SQLite file location | point at a mounted volume |

### TLS requirement
The `Secure` session cookie requires HTTPS. Run the container behind a TLS-terminating
proxy (or set `COOKIE_SECURE=true`) in production. For plain-`http` local access, keep
`COOKIE_SECURE=false`.

### Data persistence
The SQLite database lives at `VKON_DB_PATH` (`/app/data/vkon.db` in the container). The
provided `docker-compose.yml` mounts a named `vkon-data` volume so data survives restarts.

### API surface
- `POST /api/auth/login`, `POST /api/auth/mfa/verify`, `POST /api/auth/logout`
- `GET /api/session`, `GET /api/auth/mfa/setup`
- `GET /api/state`, `PATCH /api/state/{key}`
- `GET /api/health`

### Tests
- Backend: `pytest server/test_api.py` (auth, admin MFA gate, lockout, and role/ownership 403s).
- Legacy static feature verifiers (still green): `verify_checkin_and_login.py`,
  `verify_present_day_and_all.py`, `verify_ist_clock_and_time.py`, `verify_requirements.py`,
  `verify_three_new_features.py`, `verify_new_4_requests.py`, `test_all_8_requirements.py`.
