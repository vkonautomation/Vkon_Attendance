"""Session lifecycle + FastAPI auth dependencies (cookie -> user)."""
import time
from typing import Optional

from fastapi import Depends, HTTPException, Request, Response, status

from .config import config
from .db import get_db
from .security import hash_token, new_session_token


def create_session(user_id: str, mfa_verified: bool) -> str:
    """Persist a new server-side session and return the raw token (cookie value)."""
    token = new_session_token()
    now = time.time()
    with get_db() as db:
        db.execute(
            """INSERT INTO sessions
               (token_hash, user_id, created_at, last_seen, expires_at, absolute_expires_at, mfa_verified)
               VALUES (?, ?, ?, ?, ?, ?, ?)""",
            (
                hash_token(token), user_id, now, now,
                now + config.SESSION_IDLE_SECONDS,
                now + config.SESSION_ABSOLUTE_SECONDS,
                1 if mfa_verified else 0,
            ),
        )
    return token


def destroy_session(token: str) -> None:
    if not token:
        return
    with get_db() as db:
        db.execute("DELETE FROM sessions WHERE token_hash = ?", (hash_token(token),))


def set_session_cookie(response: Response, token: str) -> None:
    response.set_cookie(
        key=config.COOKIE_NAME,
        value=token,
        max_age=config.SESSION_ABSOLUTE_SECONDS,
        httponly=True,
        secure=config.COOKIE_SECURE,
        samesite=config.COOKIE_SAMESITE,
        path="/",
    )


def clear_session_cookie(response: Response) -> None:
    response.delete_cookie(key=config.COOKIE_NAME, path="/")


def _row_to_user(row, mfa_verified: bool) -> dict:
    return {
        "id": row["id"],
        "kind": row["kind"],
        "employee_id": row["employee_id"],
        "name": row["name"],
        "username": row["username"],
        "email": row["email"],
        "role_title": row["role_title"],
        "department": row["department"],
        "mfa_verified": mfa_verified,
    }


def resolve_user(token: Optional[str]) -> Optional[dict]:
    """Return the authenticated user for a session token, sliding the idle expiry."""
    if not token:
        return None
    now = time.time()
    with get_db() as db:
        sess = db.execute(
            "SELECT * FROM sessions WHERE token_hash = ?", (hash_token(token),)
        ).fetchone()
        if not sess:
            return None
        if sess["expires_at"] <= now or sess["absolute_expires_at"] <= now:
            db.execute("DELETE FROM sessions WHERE token_hash = ?", (hash_token(token),))
            return None
        user = db.execute("SELECT * FROM users WHERE id = ? AND active = 1", (sess["user_id"],)).fetchone()
        if not user:
            return None
        new_expires = min(now + config.SESSION_IDLE_SECONDS, sess["absolute_expires_at"])
        db.execute(
            "UPDATE sessions SET last_seen = ?, expires_at = ? WHERE token_hash = ?",
            (now, new_expires, hash_token(token)),
        )
    return _row_to_user(user, bool(sess["mfa_verified"]))


def get_current_user(request: Request) -> dict:
    user = resolve_user(request.cookies.get(config.COOKIE_NAME))
    if not user:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Not authenticated")
    return user


def require_admin(user: dict = Depends(get_current_user)) -> dict:
    if user.get("kind") != "admin":
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Administrator privileges required")
    return user
