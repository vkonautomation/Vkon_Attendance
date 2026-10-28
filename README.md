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
* **`app/api/` — the server:** route handlers only, no pages. `health` is live;
  auth, punches, state and the rest arrive per milestone.
* **`lib/`** — database access and HTTP helpers shared by the route handlers.
* **`server/`** — the outgoing FastAPI backend, still the thing production runs
  until the Next.js one is verified. It reads the same `public/` directory.
* **`scripts/`** — `start-standalone.mjs` assembles and runs the deployable
  payload; `run-tests.mjs` is the whole suite in one command.
* **`tests/`** — `probe.mjs` asserts the shape of the running server (which URLs
  answer, which headers are set, what must stay unreachable).
* **Verification and testing scripts** (`test_*.js`, `verify_*.py`,
  `test_backend.py`) sit at the repository root and load the portal from
  `public/`; `node scripts/run-tests.mjs` runs all of them.

---

## 🚀 Installation Instructions

Follow these steps to set up the project locally for development and testing:

1. **Clone the Repository:**
   ```bash
   git clone [https://github.com/your-username/your-attendance-repo.git](https://github.com/your-username/your-attendance-repo.git)
   cd ATTENDANCE
