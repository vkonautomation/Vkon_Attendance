"""Who is allowed to write what.

This module is the reason the backend is worth having. A shared database that any
browser can overwrite in full is not a source of truth, it is a shared target.
Every write to a store document is checked here before it is committed, by
diffing the submitted document against the stored one:

  * a store an employee has no business touching is rejected outright
    (the roster, holidays, pay policy, approval routing);
  * within a store they do own rows of, they may only add or change rows that
    belong to them;
  * and they may never set an approval outcome. "Approved" and "Rejected" are
    decisions, and decisions belong to a manager or an admin.

The checks are deliberately written against the *change*, not the whole document:
a client that resends a store it did not modify must not be rejected, and a client
that quietly rewrites one row of someone else's history while resending the rest
must be.
"""

from .models import ROLE_ADMIN, ROLE_MANAGER

# Keys the browser keeps to itself. Persisting them server-side would be worse
# than not persisting them: a theme or a live session should not follow a person
# onto a shared laptop.
LOCAL_ONLY_KEYS = frozenset({
    "vkon_session_v6",
    "vkon_theme_v6",
    "vkon_regalert_seen_v1",
})

# Configuration and anything that decides other people's pay.
ADMIN_ONLY_KEYS = frozenset({
    "vkon_settings_v6",
    "vkon_employees_v6",
    "vkon_holidays_v6",
    "vkon_leave_quotas_v6",
    "vkon_min_work_policy_v6",
    "vkon_short_leave_settings_v1",
    "vkon_approval_flow_v1",
    "vkon_lop_entries_v1",
    "vkon_admin_creds_v6",
    "vkon_admin_decision_snap_v6",
})

# Requests and records: the employee owns their own rows, an approver owns the
# decision on everybody's.
SELF_SERVICE_KEYS = frozenset({
    "vkon_records_v6",
    "vkon_wfh_v6",
    "vkon_leaves_v6",
    "vkon_regularisations_v6",
    "vkon_notifications_v6",
    "vkon_holiday_work_v1",
})

# Statuses that only a manager or an admin may put on a row. Everything else in
# the workflow (Pending Manager, Pending Admin, Cancelled, Cancellation Requested)
# is something an employee does to their own request.
APPROVER_STATUSES = frozenset({"Approved", "Rejected"})

# Outcomes an approver may not rewrite either, once recorded.
IMMUTABLE_STATUSES = frozenset({"Approved", "Rejected"})


class PolicyError(Exception):
    """A write that will not be accepted, with a message safe to show the user."""

    def __init__(self, message: str, status_code: int = 403):
        super().__init__(message)
        self.message = message
        self.status_code = status_code


def permission_for(key: str) -> str:
    if key in LOCAL_ONLY_KEYS:
        return "local"
    if key in ADMIN_ONLY_KEYS:
        return "admin"
    if key in SELF_SERVICE_KEYS:
        return "self"
    # Unknown keys are refused rather than assumed harmless: a new store added to
    # shared.js does not become world-writable just because nobody updated here.
    return "unknown"


def owner_of(entry, key_hint: str = "") -> str | None:
    """The employee a row belongs to, from whichever field this store uses."""
    if isinstance(entry, dict):
        for field in ("employeeId", "empId", "for", "owner"):
            value = entry.get(field)
            if value:
                return str(value)
    # Record stores are keyed "EMP001_2026-10-27"; fall back to the key prefix.
    if key_hint and "_" in key_hint:
        prefix = key_hint.split("_")[0]
        if prefix.startswith("EMP"):
            return prefix
    return None


def _rows(value):
    """Yield (identity, owner, status) for every row in a store document."""
    if isinstance(value, dict):
        for k, v in value.items():
            yield str(k), owner_of(v, k), (v.get("status") if isinstance(v, dict) else None)
    elif isinstance(value, list):
        for i, v in enumerate(value):
            ident = str(v.get("id") or v.get("requestId") or f"#{i}") if isinstance(v, dict) else f"#{i}"
            yield ident, owner_of(v), (v.get("status") if isinstance(v, dict) else None)


def check_write(key: str, old_value, new_value, user, reports=None) -> None:
    """Raise PolicyError if `user` may not persist this change.

    `reports` is the set of employee ids this user may approve for; managers get
    it from the roster's manager link, admins bypass the check entirely.
    """
    level = permission_for(key)

    if level == "local":
        raise PolicyError(f"{key} is browser-local state and is not stored on the server.", 400)
    if level == "unknown":
        raise PolicyError(f"Unknown store {key}; the server does not accept writes to it.", 400)

    if user.role == ROLE_ADMIN:
        return  # An admin's authority is the point of the admin role.

    if level == "admin":
        raise PolicyError(
            "Only an administrator can change company settings, the roster or pay policy.", 403)

    if level == "self":
        _check_self_service(key, old_value, new_value, user, reports or set())


def _check_self_service(key: str, old_value, new_value, user, reports) -> None:
    me = user.employee_id
    if not me:
        raise PolicyError("This account is not linked to an employee record.", 403)

    old_rows = {ident: (owner, status) for ident, owner, status in _rows(old_value)}
    new_rows = {ident: (owner, status) for ident, owner, status in _rows(new_value)}

    for ident, (owner, status) in new_rows.items():
        if owner and owner != me and owner not in reports:
            raise PolicyError(
                f"You may not add or change a row in {key} that belongs to {owner}.", 403)
        previous = old_rows.get(ident)
        if previous is None:
            # A brand new row: ownership was checked above; a fresh request may
            # legitimately carry a pending status.
            if status in APPROVER_STATUSES and user.role not in (ROLE_MANAGER,):
                raise PolicyError("Only an approver can record an approval outcome.", 403)
            continue
        _old_owner, old_status = previous
        if old_status != status and status in APPROVER_STATUSES:
            if user.role != ROLE_MANAGER:
                raise PolicyError(
                    f"Changing the outcome of a request to '{status}' needs an approver.", 403)
            if _old_owner and _old_owner not in reports and _old_owner != me:
                raise PolicyError("You can only approve requests from your direct reports.", 403)

    for ident, (owner, status) in old_rows.items():
        if ident in new_rows:
            continue
        if status in IMMUTABLE_STATUSES:
            raise PolicyError(
                "A decided request cannot be deleted; cancel it or raise a new one.", 403)
        if owner and owner != me and owner not in reports:
            raise PolicyError(f"You may not delete a row in {key} that belongs to {owner}.", 403)
