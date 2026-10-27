"""HTTP surface.

Design notes that matter more than the routes themselves:

  * Everything is same-origin with the front end. The browser bundle talks to
    /api/* with a signed session cookie; there is no CORS, no bearer token in
    localStorage, and therefore no XSS that can lift a token out of storage.
  * State is read in one call. On a rural connection a page that issues eighteen
    GETs is slower and fails more often than one that issues a single /api/state.
  * Writes are versioned. A client sends the version it read; a mismatch is a 409
    carrying the current document, so the client merges instead of silently
    overwriting a colleague's change.
  * Errors are JSON with a message that is safe to show. No stack traces, no
    SQL, and no distinction between "no such user" and "wrong password" on the
    login path.
"""

from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, Request, status
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from sqlalchemy import func
from sqlalchemy.orm import Session

from . import config, policy, presence, security, seed
from .db import get_db
from .models import ROLE_ADMIN, AuditEntry, PunchEvent, StoreDoc, User, utcnow
from .schemas import LoginRequest, PasswordChange, PunchIn, StoreWrite

router = APIRouter(prefix="/api")


# --------------------------------------------------------------------------
# helpers
# --------------------------------------------------------------------------

def error(code: int, message: str, **extra) -> JSONResponse:
    return JSONResponse(status_code=code, content={"error": {"message": message, **extra}})


def client_key(request: Request) -> str:
    """Best available source identity for rate limiting.

    Behind a Cloudflare Tunnel `request.client.host` is the tunnel, which would
    collapse every user onto one counter and turn brute-force relief into a
    denial-of-service against the whole company. The connecting IP header is only
    trusted when the deployment explicitly says it sits behind a proxy.
    """
    if config.TRUST_PROXY_HEADERS:
        for header in ("cf-connecting-ip", "x-real-ip", "x-forwarded-for"):
            value = request.headers.get(header)
            if value:
                return value.split(",")[0].strip()
    return request.client.host if request.client else "unknown"


def current_user(db: Session, request: Request) -> User | None:
    user_id = (request.session or {}).get("uid")
    if not user_id:
        return None
    user = db.get(User, user_id)
    if not user or user.disabled:
        return None
    return user


def require_login(request: Request, db: Session = Depends(get_db)) -> User:
    """Authenticated, and past the forced password change.

    An account still carrying a generated password may only read its own session
    and change that password. Without this gate the one-time credentials written
    to initial-credentials.txt stay valid indefinitely, which is exactly the
    failure mode generating them was meant to avoid.
    """
    user = current_user(db, request)
    if not user:
        raise AuthError("Not signed in.")
    if user.must_change_password and not request.url.path.startswith("/api/auth/"):
        raise AuthError("Sign in and choose a new password before continuing.",
                        code=status.HTTP_403_FORBIDDEN,
                        reason="password_change_required")
    return user


class AuthError(Exception):
    def __init__(self, message: str, code: int = status.HTTP_401_UNAUTHORIZED, reason: str = None):
        super().__init__(message)
        self.message = message
        self.code = code
        self.reason = reason


def audit(db: Session, user: User | None, action: str, target: str = None, detail: dict = None):
    db.add(AuditEntry(
        actor_user_id=user.id if user else None,
        actor_label=(user.username if user else "anonymous"),
        action=action, target=target, detail=detail or {},
    ))


def reports_for(db: Session, user: User) -> set:
    if user.role == ROLE_ADMIN:
        return set()  # admins short-circuit the policy check before this matters
    employees = get_doc(db, "vkon_employees_v6")
    return seed.direct_reports_of(db, user, employees)


def get_doc(db: Session, key: str):
    doc = db.get(StoreDoc, key)
    return doc.value if doc else None


# --------------------------------------------------------------------------
# health and session
# --------------------------------------------------------------------------

class HealthOut(BaseModel):
    status: str = "ok"
    api: str = "v1"


@router.get("/health", response_model=HealthOut)
def health() -> HealthOut:
    """Public liveness probe. Deliberately says nothing about the data inside.

    The front end calls this on boot to decide whether to run in server mode or
    fall back to localStorage, so it must answer fast, require nothing, and leak
    nothing to someone who is not signed in.
    """
    return HealthOut()


@router.get("/auth/me")
def whoami(request: Request, db: Session = Depends(get_db)) -> dict:
    user = current_user(db, request)
    if not user:
        return {"signedIn": False}
    return {
        "signedIn": True,
        "id": user.id,
        "username": user.username,
        "name": user.display_name,
        "role": user.role,
        "employeeId": user.employee_id,
        "mustChangePassword": user.must_change_password,
    }


@router.post("/auth/login")
def login(body: LoginRequest, request: Request,
          db: Session = Depends(get_db)):
    identifier = (body.identifier or "").strip()
    if not identifier:
        return error(400, "Enter your username or employee ID.")

    account_key = f"acct:{identifier.lower()}"
    source_key = f"src:{client_key(request)}"
    for key in (account_key, source_key):
        wait = security.login_guard.seconds_until_retry(key)
        if wait:
            return error(429, f"Too many attempts. Try again in {wait} seconds.",
                         retryAfter=wait)

    user = (db.query(User)
            .filter(func.lower(User.username) == identifier.lower())
            .filter(User.disabled.is_(False))
            .first())
    if not user:
        user = (db.query(User)
                .filter(User.employee_id == identifier.upper())
                .filter(User.disabled.is_(False))
                .first())

    ok = security.verify_password(body.password, user.password_hash if user else None)
    if not (user and ok):
        # One message for both failure modes, so the endpoint cannot be used to
        # enumerate who has an account.
        security.login_guard.record_failure(account_key)
        security.login_guard.record_failure(source_key)
        audit(db, user, "login.failed", identifier)
        db.commit()
        return error(401, "Incorrect username or password.")

    security.login_guard.record_success(account_key)
    security.login_guard.record_success(source_key)
    request.session.clear()
    request.session["uid"] = user.id
    request.session["role"] = user.role
    request.session["name"] = user.display_name
    user.failed_attempts = 0
    user.last_login_at = utcnow()
    audit(db, user, "login")
    db.commit()

    return {
        "signedIn": True,
        "id": user.id,
        "username": user.username,
        "name": user.display_name,
        "role": user.role,
        "employeeId": user.employee_id,
        "mustChangePassword": user.must_change_password,
    }


@router.post("/auth/logout")
def logout(request: Request, db: Session = Depends(get_db)) -> dict:
    user = current_user(db, request)
    if user:
        audit(db, user, "logout")
        db.commit()
    request.session.clear()
    return {"signedIn": False}


@router.post("/auth/password")
def change_password(body: PasswordChange, request: Request,
                    db: Session = Depends(get_db)):
    user = require_login(request, db)
    if not security.verify_password(body.currentPassword, user.password_hash):
        return error(401, "Your current password is not correct.")
    problem = security.password_problem(body.newPassword, user.username)
    if problem:
        return error(400, problem)
    user.password_hash = security.hash_password(body.newPassword)
    user.must_change_password = False
    audit(db, user, "password.changed")
    db.commit()
    return {"ok": True}


# --------------------------------------------------------------------------
# shared state
# --------------------------------------------------------------------------

@router.get("/state")
def read_state(request: Request, db: Session = Depends(get_db)) -> dict:
    """Every store document the server holds, with its version.

    One round trip on purpose: the client hydrates its whole cache from this and
    then serves getStore() synchronously out of memory.
    """
    require_login(request, db)
    docs = db.query(StoreDoc).all()
    return {
        "serverVersion": sum(d.version for d in docs),
        "stores": {d.key: {"value": d.value, "version": d.version} for d in docs},
    }


@router.put("/state/{key}")
def write_state(key: str, body: StoreWrite, request: Request,
                db: Session = Depends(get_db)):
    user = require_login(request, db)

    doc = db.get(StoreDoc, key)
    current_version = doc.version if doc else 0

    if body.baseVersion != current_version:
        # The caller read a stale document. Hand back what is actually stored so
        # the client can merge, rather than choosing between losing one side.
        return error(409, f"{key} changed on the server (version {current_version}).",
                     currentVersion=current_version,
                     currentValue=doc.value if doc else None)

    old_value = doc.value if doc else None
    try:
        policy.check_write(key, old_value, body.value, user, reports_for(db, user))
    except policy.PolicyError as exc:
        audit(db, user, "state.rejected", key, {"reason": exc.message})
        db.commit()
        return error(exc.status_code, exc.message)

    if doc is None:
        doc = StoreDoc(key=key, value=body.value, version=1, updated_by=user.id)
        db.add(doc)
    else:
        doc.value = body.value
        doc.version = current_version + 1
        doc.updated_by = user.id
    audit(db, user, "state.write", key, {"version": doc.version})

    if key == "vkon_employees_v6" and user.role == ROLE_ADMIN:
        # The roster is the list of who exists, so publishing it provisions
        # accounts. Done inside the same request so a new employee can sign in
        # immediately after the admin adds them.
        seed.ensure_users_from_roster(db, body.value)

    db.commit()
    return {"key": key, "version": doc.version}


# --------------------------------------------------------------------------
# punches
# --------------------------------------------------------------------------

@router.post("/punches")
def record_punch(body: PunchIn, request: Request, db: Session = Depends(get_db)):
    """Append a punch as the server observed it. Idempotent on punch_id.

    This is the local-first seam: the client records the punch immediately,
    queues it, and replays it here when a connection appears. Re-sending the same
    punch_id must not create a second punch, so the unique index is the answer and
    a duplicate returns the original row with `duplicate: true`.

    Phase 1 keeps this as authoritative *evidence* - server clock, server-computed
    geofence verdict - while the attendance day itself is still derived by the
    client's shared.js and synced as a store document. Deriving records from these
    events is the next step; doing it now would mean two writers deciding each day.
    """
    user = require_login(request, db)
    employee_id = body.employeeId or user.employee_id
    if not employee_id:
        return error(400, "No employee record is linked to this account.")
    if employee_id != user.employee_id and user.role != ROLE_ADMIN:
        return error(403, "You may only record your own punches.")
    if body.kind not in ("in", "out"):
        return error(400, "kind must be 'in' or 'out'.")

    existing = db.query(PunchEvent).filter(PunchEvent.punch_id == body.punchId).first()
    if existing:
        return _punch_out(existing, duplicate=True)

    received = datetime.now(timezone.utc)
    captured = body.clientCapturedAt
    if captured and captured.tzinfo is None:
        captured = captured.replace(tzinfo=timezone.utc)
    if not captured or captured > received + timedelta(minutes=10):
        # A client clock running ahead would otherwise book a punch in the future.
        captured = received

    distance, inside, note = presence.geofence_verdict(
        body.latitude, body.longitude, body.accuracyM)

    event = PunchEvent(
        punch_id=body.punchId,
        employee_id=employee_id,
        kind=body.kind,
        client_captured_at=captured,
        server_received_at=received,
        ist_date=presence.ist_date(received),
        latitude=body.latitude,
        longitude=body.longitude,
        accuracy_m=body.accuracyM,
        distance_m=distance,
        inside_geofence=inside,
        notes=note,
        actor_user_id=user.id,
    )
    db.add(event)
    audit(db, user, "punch", f"{employee_id}:{body.kind}",
          {"punchId": body.punchId, "istDate": event.ist_date, "inside": inside})
    db.commit()
    return _punch_out(event, duplicate=False)


def _punch_out(event: PunchEvent, duplicate: bool) -> dict:
    return {
        "punchId": event.punch_id,
        "employeeId": event.employee_id,
        "kind": event.kind,
        "istDate": event.ist_date,
        "serverTime": presence.ist_clock(event.server_received_at),
        "insideGeofence": event.inside_geofence,
        "distanceM": event.distance_m,
        "note": event.notes,
        "duplicate": duplicate,
    }


@router.get("/punches")
def list_punches(request: Request, date: str | None = None, employeeId: str | None = None,
                 limit: int = 500, db: Session = Depends(get_db)) -> dict:
    user = require_login(request, db)
    query = db.query(PunchEvent)
    if user.role != ROLE_ADMIN:
        # Everyone else sees their own history and nothing more; a manager's view
        # of their team's punches comes through the shared store documents.
        query = query.filter(PunchEvent.employee_id == (user.employee_id or ""))
    elif employeeId:
        query = query.filter(PunchEvent.employee_id == employeeId)
    if date:
        query = query.filter(PunchEvent.ist_date == date)
    rows = query.order_by(PunchEvent.server_received_at.desc()).limit(min(limit, 2000)).all()
    return {"punches": [_punch_out(r, False) for r in rows]}


@router.get("/audit")
def read_audit(request: Request, limit: int = 200, db: Session = Depends(get_db)):
    user = require_login(request, db)
    if user.role != ROLE_ADMIN:
        return error(403, "Only an administrator can read the audit trail.")
    rows = (db.query(AuditEntry)
            .order_by(AuditEntry.at.desc())
            .limit(min(limit, 1000)).all())
    return {"entries": [{
        "at": r.at.isoformat() + "Z",
        "actor": r.actor_label,
        "action": r.action,
        "target": r.target,
        "detail": r.detail,
    } for r in rows]}
