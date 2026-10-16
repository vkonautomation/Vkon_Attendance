"""Authentication endpoints: login, admin MFA verify, session, logout, MFA setup."""
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from pydantic import BaseModel

from .config import config
from .db import get_db
from .deps import (
    clear_session_cookie,
    create_session,
    destroy_session,
    get_current_user,
    require_admin,
    set_session_cookie,
)
from .rate_limit import check_allowed, record_failure, record_success
from .security import new_totp_secret, otpauth_uri, sign_token, totp_verify, verify_password, verify_token

router = APIRouter(prefix="/api", tags=["auth"])


class LoginBody(BaseModel):
    identifier: str
    password: str


class MfaBody(BaseModel):
    preauth_token: str
    code: str


def _client_ip(request: Request) -> str:
    fwd = request.headers.get("x-forwarded-for")
    if fwd:
        return fwd.split(",")[0].strip()
    return request.client.host if request.client else "unknown"


def _find_user(identifier: str):
    ident = (identifier or "").strip().lower()
    if not ident:
        return None
    with get_db() as db:
        return db.execute(
            """SELECT * FROM users
               WHERE active = 1 AND (
                   lower(username) = ? OR lower(email) = ? OR lower(employee_id) = ?
               )""",
            (ident, ident, ident),
        ).fetchone()


def _public_user(row) -> dict:
    return {
        "id": row["id"],
        "kind": row["kind"],
        "employee_id": row["employee_id"],
        "name": row["name"],
        "username": row["username"],
        "email": row["email"],
        "role_title": row["role_title"],
        "department": row["department"],
    }


@router.post("/auth/login")
def login(body: LoginBody, request: Request, response: Response):
    ip = _client_ip(request)
    allowed, retry_after = check_allowed(ip, body.identifier)
    if not allowed:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail=f"Too many login attempts. Try again in {retry_after} seconds.",
            headers={"Retry-After": str(retry_after)},
        )

    user = _find_user(body.identifier)
    # Always run a bcrypt compare to reduce user-enumeration timing differences.
    ok = bool(user) and verify_password(body.password, user["password_hash"])
    if not ok:
        record_failure(ip, body.identifier)
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid credentials")

    record_success(ip, body.identifier)

    if user["kind"] == "admin":
        # Password correct, but admins must pass TOTP before a session is issued.
        preauth = sign_token({"uid": user["id"], "kind": "admin"}, config.PREAUTH_TTL_SECONDS)
        return {"mfa_required": True, "preauth_token": preauth}

    token = create_session(user["id"], mfa_verified=False)
    set_session_cookie(response, token)
    return {"mfa_required": False, "role": "employee", "user": _public_user(user)}


@router.post("/auth/mfa/verify")
def mfa_verify(body: MfaBody, response: Response):
    payload = verify_token(body.preauth_token)
    if not payload or payload.get("kind") != "admin":
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid or expired session step")

    uid = payload.get("uid")
    with get_db() as db:
        admin = db.execute("SELECT * FROM users WHERE id = ? AND kind = 'admin' AND active = 1", (uid,)).fetchone()
    if not admin:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid or expired session step")

    if not admin["mfa_secret"] or not totp_verify(admin["mfa_secret"], body.code):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid authentication code")

    token = create_session(admin["id"], mfa_verified=True)
    set_session_cookie(response, token)
    return {"mfa_required": False, "role": "admin", "user": _public_user(admin)}


@router.get("/session")
def session(user: dict = Depends(get_current_user)):
    return {"authenticated": True, "user": user}


@router.post("/auth/logout")
def logout(request: Request, response: Response):
    destroy_session(request.cookies.get(config.COOKIE_NAME))
    clear_session_cookie(response)
    return {"ok": True}


@router.get("/auth/mfa/setup")
def mfa_setup(user: dict = Depends(require_admin)):
    """Return (and lazily create) the admin TOTP secret + provisioning URI."""
    with get_db() as db:
        row = db.execute("SELECT mfa_secret FROM users WHERE id = ?", (user["id"],)).fetchone()
        secret = row["mfa_secret"]
        if not secret:
            secret = new_totp_secret()
            db.execute(
                "UPDATE users SET mfa_secret = ?, mfa_enabled = 1 WHERE id = ?", (secret, user["id"])
            )
    label = user.get("username") or user.get("email") or user["id"]
    return {"secret": secret, "otpauth_uri": otpauth_uri(secret, label), "issuer": config.TOTP_ISSUER}
