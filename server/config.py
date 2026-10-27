"""Environment-driven configuration.

Every value has a working default so that `uvicorn server.main:app` starts on a
developer laptop with no .env at all. The one value that must never be defaulted
into a real deployment is SESSION_SECRET, and `warnings()` reports it.
"""

import os
import secrets
from pathlib import Path

# Where runtime data goes. Outside the served docroot in every deployment: the
# container mounts a named volume here and the static image never sees it.
DATA_DIR = Path(os.getenv("VKON_DATA_DIR", "./data")).resolve()

ENV = os.getenv("VKON_ENV", "development").lower()
IS_PROD = ENV in ("production", "prod")

# SQLite file. A single file keeps the self-hosted compose stack to one container;
# see the note in requirements.txt for when that stops being the right call.
DB_PATH = Path(os.getenv("VKON_DB_PATH", str(DATA_DIR / "vkon.db"))).resolve()

DATABASE_URL = f"sqlite:///{DB_PATH.as_posix()}"

# Session signing. In production an empty secret is a misconfiguration, not a
# default: the app refuses to start rather than run on an ephemeral key, because
# an ephemeral key silently logs everyone out on every restart and, worse, hides
# the fact that no real secret was ever installed.
SESSION_SECRET = os.getenv("SESSION_SECRET", "")
if not SESSION_SECRET:
    if IS_PROD:
        # Refuse here, with the reason and the fix, instead of letting Starlette's
        # middleware raise an opaque AssertionError three frames deeper. A container
        # that crash-loops on a blank secret is a deployment that never silently
        # signs sessions with a key that changes every boot.
        raise RuntimeError(
            "SESSION_SECRET is required when VKON_ENV=production. Generate one and "
            "put it in the untracked .env (never in a committed file):\n"
            '    python -c "import secrets; print(secrets.token_urlsafe(48))"\n'
            "Without a real secret every session cookie would be signed with a key "
            "that disappears on restart, and anyone reading this file could forge "
            "sessions for the whole company."
        )
    SESSION_SECRET = secrets.token_urlsafe(48)

# HTTPS-only deployments get a Secure cookie. Off by default so plain-http LAN
# access keeps working; .env.example documents flipping it to true.
COOKIE_SECURE = os.getenv("COOKIE_SECURE", "false").lower() in ("1", "true", "yes")
COOKIE_NAME = "vkon_session"
SESSION_MAX_AGE_SECONDS = int(os.getenv("SESSION_MAX_AGE", 8 * 60 * 60))

# Brute-force relief. Small and deliberately simple: an in-memory counter is
# enough to make password spraying expensive, and it does not need a database
# round trip on the hot path. It resets on restart, which is acceptable here.
LOGIN_MAX_ATTEMPTS = int(os.getenv("VKON_LOGIN_MAX_ATTEMPTS", "5"))
LOGIN_COOLDOWN_SECONDS = int(os.getenv("VKON_LOGIN_COOLDOWN", "60"))

# Set true only when the container sits behind a reverse proxy or a Cloudflare
# Tunnel that rewrites the client address. Trusting X-Forwarded-For from an
# untrusted network lets anyone forge the source IP and dodge rate limiting.
TRUST_PROXY_HEADERS = os.getenv("VKON_TRUST_PROXY_HEADERS", "false").lower() in ("1", "true", "yes")

# Office geofence, mirrored from the client's DEFAULT_OFFICE. The server re-checks
# it so a tampered client cannot claim to have been on site.
OFFICE_LAT = float(os.getenv("VKON_OFFICE_LAT", "12.9716"))
OFFICE_LNG = float(os.getenv("VKON_OFFICE_LNG", "77.5946"))
OFFICE_RADIUS_M = int(os.getenv("VKON_OFFICE_RADIUS", "500"))
# A phone reporting 5 km accuracy was not meaningfully at the office.
MAX_TRUSTED_ACCURACY_M = int(os.getenv("VKON_MAX_ACCURACY", "100"))


def ensure_data_dir() -> Path:
    """Create the runtime data directory and return its path."""
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    return DATA_DIR


def warnings() -> list:
    """Configuration problems worth printing at boot, but not dying for.

    An empty SESSION_SECRET in production is not in here: config.py refuses to
    import at all in that case, which is a stronger statement than a log line.
    """
    out = []
    if not str(DB_PATH).startswith(str(DATA_DIR)):
        out.append(f"database is at {DB_PATH}, outside {DATA_DIR}; back up the "
                   "wrong path at your peril.")
    if not COOKIE_SECURE and IS_PROD:
        out.append("COOKIE_SECURE is false while VKON_ENV=production; the session "
                   "cookie will be sent over plain http.")
    return out
