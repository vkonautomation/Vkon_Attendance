"""Password hashing, strength rules and brute-force relief.

bcrypt rather than sha256: it is slow by design, which is the only property that
matters for a stored password. A hash of a short attendance password computed with
sha256 is crackable at billions per second on a laptop; bcrypt is not.
"""

import hmac
import secrets
import time
from collections import deque

import bcrypt

from . import config

# bcrypt silently ignores everything past 72 bytes, so a 100-character passphrase
# would authenticate on its first 72. Reject rather than surprise.
MAX_PASSWORD_BYTES = 72
MIN_PASSWORD_CHARS = 8


def hash_password(password: str) -> str:
    if not password or len(password.encode("utf-8")) > MAX_PASSWORD_BYTES:
        raise ValueError("password must be between 1 and 72 bytes")
    return bcrypt.hashpw(password.encode("utf-8"), bcrypt.gensalt()).decode("ascii")


def verify_password(password: str, hashed: str | None) -> bool:
    """Constant-time comparison, delegated to bcrypt.checkpw."""
    if not password or not hashed:
        return False
    try:
        return bcrypt.checkpw(password.encode("utf-8"), hashed.encode("ascii"))
    except (ValueError, TypeError):
        # A corrupt or non-bcrypt hash must read as "wrong password", never as a
        # 500 that tells an attacker the account exists.
        return False


def password_problem(password: str, username: str = "") -> str | None:
    """Return a human reason to reject this password, or None if it is fine."""
    if not password or len(password.strip()) < MIN_PASSWORD_CHARS:
        return f"Password must be at least {MIN_PASSWORD_CHARS} characters."
    if len(password.encode("utf-8")) > MAX_PASSWORD_BYTES:
        return f"Password must be at most {MAX_PASSWORD_BYTES} bytes."
    lowered = password.lower()
    if username and lowered == username.lower():
        return "Password must not be the same as the username."
    if lowered in ("password", "vkon1234", "admin123", "12345678"):
        # The values this project has already burned in demos and git history.
        return "That password is on the blocklist. Choose another."
    return None


def random_temporary_password() -> str:
    """A one-time password for account creation. Long enough to be unguessable,
    encoded so it survives being read aloud over a phone."""
    alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789"
    return "".join(secrets.choice(alphabet) for _ in range(12))


class LoginGuard:
    """Per-account and per-source attempt counters, in memory.

    Two independent keys matter: the account, so one attacker cannot lock out a
    whole company by hammering one username from many IPs; and the source, so a
    single noisy laptop cannot spray the roster. Both reset on restart, which is
    acceptable for a 40-person deployment and documented as such.
    """

    def __init__(self, max_attempts: int, cooldown_seconds: int):
        self.max_attempts = max_attempts
        self.cooldown = cooldown_seconds
        self._failures: dict[str, deque] = {}

    def _prune(self, key: str, now: float) -> deque:
        window = self._failures.setdefault(key, deque())
        cutoff = now - self.cooldown
        while window and window[0] < cutoff:
            window.popleft()
        return window

    def seconds_until_retry(self, key: str) -> int:
        now = time.monotonic()
        window = self._prune(key, now)
        if len(window) < self.max_attempts:
            return 0
        return max(1, int(window[0] + self.cooldown - now))

    def record_failure(self, key: str) -> None:
        self._prune(key, time.monotonic()).append(time.monotonic())

    def record_success(self, key: str) -> None:
        self._failures.pop(key, None)

    def clear(self) -> None:
        self._failures.clear()


login_guard = LoginGuard(config.LOGIN_MAX_ATTEMPTS, config.LOGIN_COOLDOWN_SECONDS)


def timing_safe_equal(a: str, b: str) -> bool:
    """For comparing opaque tokens (CSRF, punch ids). Not for passwords."""
    return hmac.compare_digest(a.encode(), b.encode())
