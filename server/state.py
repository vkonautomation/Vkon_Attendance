"""Server-authoritative application state.

GET  /api/state          -> role-filtered dataset (employees see only their own rows)
PATCH /api/state/{key}   -> write gated by role + ownership; the server merges an
                            employee's own subset so they can never touch others'.
"""
from typing import Any, Dict

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel

from .config import ADMIN_ONLY_KEYS, OWNED_KEYS, STATE_KEYS, config
from .db import get_db
from .deps import get_current_user
from .security import hash_password
from .store import get_state, set_state

router = APIRouter(prefix="/api/state", tags=["state"])

VALID_KEYS = set(STATE_KEYS.values())
RECORDS_KEY = STATE_KEYS["records"]
EMPLOYEES_KEY = STATE_KEYS["employees"]


class ValueBody(BaseModel):
    value: Any


def _owned_by(item: Any, employee_id: str) -> bool:
    return isinstance(item, dict) and item.get("employeeId") == employee_id


def _filter_for_employee(key: str, value: Any, employee_id: str) -> Any:
    if key == EMPLOYEES_KEY:
        roster = value if isinstance(value, list) else []
        return [e for e in roster if isinstance(e, dict) and e.get("id") == employee_id]
    if key == RECORDS_KEY:
        recs = value if isinstance(value, dict) else {}
        return {k: v for k, v in recs.items() if _owned_by(v, employee_id)}
    if key in OWNED_KEYS:  # lists: leaves / wfh / regularisations
        items = value if isinstance(value, list) else []
        return [x for x in items if _owned_by(x, employee_id)]
    return value  # shared read config (holidays, settings, quotas, policy)


def _sync_users_from_roster(roster) -> None:
    """Keep the `users` table (the credential authority) in step with the roster.

    Admins edit the employee roster as data; the server mirrors it into `users`
    so a newly added employee can log in and a changed password takes effect.
    The roster's plaintext `password` is only used to (re)hash the credential and
    is stripped before storing the roster value itself.
    """
    if not isinstance(roster, list):
        return
    with get_db() as db:
        for emp in roster:
            if not isinstance(emp, dict):
                continue
            eid = emp.get("id")
            if not eid:
                continue
            existing = db.execute("SELECT id FROM users WHERE id = ?", (eid,)).fetchone()
            username = (emp.get("username") or "").lower() or None
            email = (emp.get("email") or "").lower() or None
            if existing:
                pw = emp.get("password")
                if pw:
                    db.execute(
                        "UPDATE users SET username = ?, email = ?, password_hash = ?, active = 1 WHERE id = ?",
                        (username, email, hash_password(pw), eid),
                    )
            else:
                db.execute(
                    """INSERT INTO users
                       (id, kind, name, username, employee_id, email, password_hash,
                        role_title, department, geofence_enforcement, annual_leave_quota,
                        enrolled_at, mfa_secret, mfa_enabled, active)
                       VALUES (?, 'employee', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 0, 1)""",
                    (
                        eid, emp.get("name"), username, eid, email,
                        hash_password(emp.get("password") or "changeme"),
                        emp.get("role"), emp.get("department"),
                        emp.get("geofenceEnforcement"), emp.get("annualLeaveQuota") or 14,
                        emp.get("enrolledAt"),
                    ),
                )
        # Deactivate users that no longer appear in the roster (employees only).
        live_ids = {e.get("id") for e in roster if isinstance(e, dict) and e.get("id")}
        rows = db.execute("SELECT id FROM users WHERE kind = 'employee'").fetchall()
        for row in rows:
            if row["id"] not in live_ids:
                db.execute("UPDATE users SET active = 0 WHERE id = ?", (row["id"],))


def _strip_roster_passwords(roster):
    if not isinstance(roster, list):
        return roster
    cleaned = []
    for emp in roster:
        if isinstance(emp, dict):
            emp = {k: v for k, v in emp.items() if k != "password"}
        cleaned.append(emp)
    return cleaned


def _build_state(user: dict) -> Dict[str, Any]:
    out: Dict[str, Any] = {}
    employee_id = user.get("employee_id")
    is_admin = user.get("kind") == "admin"
    for key in VALID_KEYS:
        value = get_state(key, [] if key != RECORDS_KEY else {})
        out[key] = value if is_admin else _filter_for_employee(key, value, employee_id)
    return out


@router.get("")
def read_state(user: dict = Depends(get_current_user)):
    return _build_state(user)


def _merge_employee_write(key: str, submitted: Any, employee_id: str) -> None:
    """Validate that a submitted payload only touches the caller's own rows, then
    replace just that employee's slice in the authoritative store."""
    if key == RECORDS_KEY:
        if not isinstance(submitted, dict):
            raise HTTPException(status_code=400, detail="Invalid records payload")
        for _, rec in submitted.items():
            if not _owned_by(rec, employee_id):
                raise HTTPException(status_code=403, detail="Cannot modify another employee's records")
        authoritative = get_state(key, {})
        merged = {k: v for k, v in authoritative.items() if not _owned_by(v, employee_id)}
        merged.update(submitted)
        set_state(key, merged)
        return

    # list-backed owned keys
    if not isinstance(submitted, list):
        raise HTTPException(status_code=400, detail="Invalid payload")
    for item in submitted:
        if not _owned_by(item, employee_id):
            raise HTTPException(status_code=403, detail="Cannot modify another employee's data")
    authoritative = get_state(key, [])
    merged = [x for x in authoritative if not _owned_by(x, employee_id)]
    merged.extend(submitted)
    set_state(key, merged)


@router.patch("/{key}")
def write_state(key: str, body: ValueBody, user: dict = Depends(get_current_user)):
    if key not in VALID_KEYS:
        raise HTTPException(status_code=404, detail="Unknown state key")

    if user.get("kind") == "admin":
        stored_value = body.value
        if key == EMPLOYEES_KEY:
            _sync_users_from_roster(body.value)
            stored_value = _strip_roster_passwords(body.value)
        version = set_state(key, stored_value)
        return {"ok": True, "key": key, "version": version}

    employee_id = user.get("employee_id")
    if key in ADMIN_ONLY_KEYS:
        raise HTTPException(status_code=403, detail="Administrator privileges required for this data")
    if key in OWNED_KEYS:
        _merge_employee_write(key, body.value, employee_id)
        return {"ok": True, "key": key}
    raise HTTPException(status_code=403, detail="Not permitted")
