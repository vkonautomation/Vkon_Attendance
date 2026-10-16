"""Cryptographic helpers: password hashing, secure random tokens, HMAC-signed
short-lived pre-auth tokens, TOTP, and session-token hashing.
"""
import base64
import hashlib
import hmac
import json
import secrets
import time
from typing import Optional

import bcrypt
import pyotp

from .config import config


# --- Passwords (bcrypt) -----------------------------------------------------
def hash_password(plain: str) -> str:
    return bcrypt.hashpw(plain.encode("utf-8"), bcrypt.gensalt()).decode("utf-8")


def verify_password(plain: str, hashed: str) -> bool:
    try:
        return bcrypt.checkpw(plain.encode("utf-8"), hashed.encode("utf-8"))
    except (ValueError, TypeError):
        return False


# --- Session tokens ---------------------------------------------------------
def new_session_token() -> str:
    return secrets.token_urlsafe(32)


def hash_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


# --- HMAC-signed short-lived tokens (MFA pre-auth) --------------------------
def _sign(body: bytes) -> bytes:
    return hmac.new(config.SESSION_SECRET.encode("utf-8"), body, hashlib.sha256).digest()


def sign_token(payload: dict, ttl_seconds: int) -> str:
    data = dict(payload)
    data["exp"] = time.time() + ttl_seconds
    body = base64.urlsafe_b64encode(json.dumps(data).encode("utf-8"))
    sig = base64.urlsafe_b64encode(_sign(body))
    return (body + b"." + sig).decode("ascii")


def verify_token(token: str) -> Optional[dict]:
    try:
        body, sig = token.encode("ascii").split(b".")
        if not hmac.compare_digest(_sign(body), base64.urlsafe_b64decode(sig)):
            return None
        payload = json.loads(base64.urlsafe_b64decode(body))
        if float(payload.get("exp", 0)) < time.time():
            return None
        return payload
    except (ValueError, TypeError, KeyError):
        return None


# --- TOTP (admin MFA) -------------------------------------------------------
def new_totp_secret() -> str:
    return pyotp.random_base32()


def totp_verify(secret: str, code: str, valid_window: int = 1) -> bool:
    if not secret or not code:
        return False
    try:
        return pyotp.TOTP(secret).verify(code.strip(), valid_window=valid_window)
    except (ValueError, TypeError):
        return False


def otpauth_uri(secret: str, account_label: str) -> str:
    return pyotp.TOTP(secret).provisioning_uri(
        name=account_label, issuer_name=config.TOTP_ISSUER
    )
