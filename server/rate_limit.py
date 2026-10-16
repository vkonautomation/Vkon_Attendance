"""Login rate limiting + per-account lockout, backed by the login_attempts table.

Two independent guards:
  * Per-IP sliding window  -> throttles brute force from one source.
  * Per-identifier failures -> locks a specific account after repeated misses.
"""
import time
from typing import Tuple

from .config import config
from .db import get_db


def _get_bucket(db, bucket: str):
    return db.execute("SELECT count, first_at, locked_until FROM login_attempts WHERE bucket = ?", (bucket,)).fetchone()


def _set_bucket(db, bucket: str, count: int, first_at: float, locked_until: float) -> None:
    db.execute(
        """
        INSERT INTO login_attempts (bucket, count, first_at, locked_until)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(bucket) DO UPDATE SET
            count = excluded.count, first_at = excluded.first_at, locked_until = excluded.locked_until
        """,
        (bucket, count, first_at, locked_until),
    )


def check_allowed(ip: str, identifier: str) -> Tuple[bool, int]:
    """Return (allowed, retry_after_seconds)."""
    now = time.time()
    id_bucket = "id:" + (identifier or "").strip().lower()
    ip_bucket = "ip:" + (ip or "unknown")
    with get_db() as db:
        row = _get_bucket(db, id_bucket)
        if row and row["locked_until"] and row["locked_until"] > now:
            return False, int(row["locked_until"] - now)

        row = _get_bucket(db, ip_bucket)
        if row and row["first_at"] and (now - row["first_at"]) <= config.LOGIN_IP_WINDOW_SECONDS:
            if row["count"] >= config.LOGIN_IP_MAX:
                return False, int(config.LOGIN_IP_WINDOW_SECONDS - (now - row["first_at"])) or 1
    return True, 0


def record_failure(ip: str, identifier: str) -> None:
    now = time.time()
    id_bucket = "id:" + (identifier or "").strip().lower()
    ip_bucket = "ip:" + (ip or "unknown")
    with get_db() as db:
        # IP window
        row = _get_bucket(db, ip_bucket)
        if row and row["first_at"] and (now - row["first_at"]) <= config.LOGIN_IP_WINDOW_SECONDS:
            _set_bucket(db, ip_bucket, row["count"] + 1, row["first_at"], row["locked_until"] or 0)
        else:
            _set_bucket(db, ip_bucket, 1, now, 0)

        # Identifier failures -> lockout
        row = _get_bucket(db, id_bucket)
        if row and (not row["locked_until"] or row["locked_until"] <= now):
            new_count = (row["count"] or 0) + 1
        else:
            new_count = 1
        locked_until = now + config.LOGIN_LOCKOUT_SECONDS if new_count >= config.LOGIN_ID_MAX_FAILURES else 0
        _set_bucket(db, id_bucket, new_count, (row["first_at"] if row else now), locked_until)


def record_success(ip: str, identifier: str) -> None:
    """Clear the identifier's failure counter on a successful password check."""
    id_bucket = "id:" + (identifier or "").strip().lower()
    with get_db() as db:
        db.execute("DELETE FROM login_attempts WHERE bucket = ?", (id_bucket,))
