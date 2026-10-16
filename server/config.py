"""Central configuration for the VKON Attendance backend.

All values can be overridden with environment variables so the same code runs
in local development (plain http, dev secret) and production (TLS, real secret).
"""
import os
from pathlib import Path

# Absolute path to the project root (the folder that holds index.html, app.js, ...)
BASE_DIR = Path(__file__).resolve().parent.parent


def _env_bool(name: str, default: bool) -> bool:
    val = os.environ.get(name)
    if val is None:
        return default
    return val.strip().lower() in ("1", "true", "yes", "on")


def _env_int(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, default))
    except (TypeError, ValueError):
        return default


class Config:
    # --- Secrets / environment ---
    # A fixed dev value keeps local runs turn-key; production MUST set SESSION_SECRET.
    SESSION_SECRET: str = os.environ.get("SESSION_SECRET", "dev-insecure-change-me-vkon-session-secret")
    ENV: str = os.environ.get("VKON_ENV", "dev")

    # --- Paths ---
    STATIC_DIR: Path = Path(os.environ.get("VKON_STATIC_DIR", str(BASE_DIR)))
    DB_PATH: Path = Path(os.environ.get("VKON_DB_PATH", str(BASE_DIR / "data" / "vkon.db")))

    # --- Session cookie ---
    COOKIE_NAME: str = os.environ.get("VKON_COOKIE_NAME", "vkon_session")
    # Secure cookies require TLS. Off by default for local http; set COOKIE_SECURE=true in prod.
    COOKIE_SECURE: bool = _env_bool("COOKIE_SECURE", ENV == "prod")
    COOKIE_SAMESITE: str = os.environ.get("COOKIE_SAMESITE", "lax")  # lax | strict | none
    SESSION_IDLE_SECONDS: int = _env_int("SESSION_IDLE_SECONDS", 30 * 60)          # 30 min sliding
    SESSION_ABSOLUTE_SECONDS: int = _env_int("SESSION_ABSOLUTE_SECONDS", 12 * 3600)  # 12 h cap

    # --- Pre-auth (MFA) token ---
    PREAUTH_TTL_SECONDS: int = _env_int("PREAUTH_TTL_SECONDS", 5 * 60)  # 5 min

    # --- Rate limiting / lockout ---
    LOGIN_IP_WINDOW_SECONDS: int = _env_int("LOGIN_IP_WINDOW_SECONDS", 60)
    LOGIN_IP_MAX: int = _env_int("LOGIN_IP_MAX", 10)                 # attempts per window per IP
    LOGIN_ID_MAX_FAILURES: int = _env_int("LOGIN_ID_MAX_FAILURES", 5)  # failures before lockout
    LOGIN_LOCKOUT_SECONDS: int = _env_int("LOGIN_LOCKOUT_SECONDS", 15 * 60)

    # --- TOTP issuer label shown in authenticator apps ---
    TOTP_ISSUER: str = os.environ.get("TOTP_ISSUER", "VKON Attendance")


config = Config()

# Logical name -> the exact localStorage key the frontend uses, so the client
# adapter can hydrate/persist 1:1 without a translation table on the client.
STATE_KEYS = {
    "employees": "vkon_employees_v6",
    "records": "vkon_records_v6",
    "wfh": "vkon_wfh_v6",
    "leaves": "vkon_leaves_v6",
    "holidays": "vkon_holidays_v6",
    "settings": "vkon_settings_v6",
    "regularisations": "vkon_regularisations_v6",
    "leave_quotas": "vkon_leave_quotas_v6",
    "min_work_policy": "vkon_min_work_policy_v6",
}

# Which storage keys hold per-employee data (records/leaves/... keyed by employeeId).
OWNED_KEYS = {
    STATE_KEYS["records"],
    STATE_KEYS["wfh"],
    STATE_KEYS["leaves"],
    STATE_KEYS["regularisations"],
}

# Keys employees may read but never write (roster, company config).
ADMIN_ONLY_KEYS = {
    STATE_KEYS["employees"],
    STATE_KEYS["holidays"],
    STATE_KEYS["settings"],
    STATE_KEYS["leave_quotas"],
    STATE_KEYS["min_work_policy"],
}

# Shared, read-for-all config (employees read, only admins write).
SHARED_READ_KEYS = ADMIN_ONLY_KEYS - {STATE_KEYS["employees"]}
