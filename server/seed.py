"""Account bootstrap.

Identity is derived from the roster rather than maintained twice. The first time
an administrator publishes the employee store, every employee in it who does not
yet have an account gets one, with a generated temporary password and
must_change_password set. Those one-time credentials are written to a file under
the data directory, readable only by the owner, and never returned over HTTP:
the admin hands them out once and the file is deleted.

There is deliberately no default admin password. `VKON_ADMIN_PASSWORD` is used if
present; otherwise one is generated, printed exactly once at boot, and marked for
change. A shipped default is how attendance.vkon.in ended up with credentials in
its git history.
"""

import os
import stat

from . import config, security
from .models import ROLE_ADMIN, ROLE_EMPLOYEE, User

CREDENTIALS_FILE_NAME = "initial-credentials.txt"

# Fields the client's roster rows use for identity. Anything else in the row is
# payroll or presentation and stays in the store document.
IDENTITY_FIELDS = ("id", "name", "username", "role", "department", "managerId", "workEmail")


def credentials_path():
    return config.DATA_DIR / CREDENTIALS_FILE_NAME


def _write_credentials(entries: list[tuple[str, str, str]]) -> None:
    """Append newly-created logins to the one-time credentials file, 0600."""
    path = credentials_path()
    config.ensure_data_dir()
    new_file = not path.exists()
    with path.open("a", encoding="utf-8") as handle:
        if new_file:
            handle.write(
                "# VKON Attendance - one-time credentials\n"
                "# Hand these out, then delete this file. Anyone who can read it can\n"
                "# sign in as anyone listed here until they change their password.\n"
            )
        for identifier, password, note in entries:
            handle.write(f"{identifier}\t{password}\t{note}\n")
    path.chmod(stat.S_IRUSR | stat.S_IWUSR)


def ensure_admin(db) -> str | None:
    """Create the administrator account if it does not exist.

    Returns the generated password when one was needed, else None.
    """
    existing = db.query(User).filter(User.role == ROLE_ADMIN).first()
    if existing:
        return None

    from_env = os.getenv("VKON_ADMIN_PASSWORD", "")
    problem = security.password_problem(from_env, "admin") if from_env else "not supplied"
    if from_env and problem:
        # A weak configured password is a misconfiguration; say so loudly and use
        # a generated one rather than quietly installing something crackable.
        print(f"[vkon] VKON_ADMIN_PASSWORD rejected: {problem} Using a generated password.")
        from_env = ""

    password = from_env or security.random_temporary_password()
    admin = User(
        id="admin",
        employee_id=None,
        username=os.getenv("VKON_ADMIN_USERNAME", "admin"),
        display_name="VKON Administrator",
        role=ROLE_ADMIN,
        password_hash=security.hash_password(password),
        must_change_password=not from_env,
    )
    db.add(admin)
    _write_credentials([(admin.username, password, "administrator")])
    return password if not from_env else None


def ensure_users_from_roster(db, employees) -> int:
    """Create accounts for roster rows that have none. Returns how many.

    Called after an admin publishes the employee store, so the roster stays the
    single list of who exists. Existing accounts are left alone: their password,
    role and lock state are theirs, not something a roster edit resets.
    """
    if not isinstance(employees, list):
        return 0

    known = {u.employee_id for u in db.query(User.employee_id).all() if u.employee_id}
    created = 0
    for emp in employees:
        if not isinstance(emp, dict):
            continue
        emp_id = emp.get("id")
        if not emp_id or emp_id in known:
            continue
        username = (emp.get("username") or emp_id).strip().lower()
        password = security.random_temporary_password()
        db.add(User(
            id=emp_id,
            employee_id=emp_id,
            username=username,
            work_email=emp.get("workEmail"),
            display_name=emp.get("name") or emp_id,
            role=ROLE_EMPLOYEE,
            manager_id=emp.get("managerId") or None,
            password_hash=security.hash_password(password),
            must_change_password=True,
        ))
        _write_credentials([(username, password, f"{emp.get('name', emp_id)} ({emp_id})")])
        created += 1
    if created:
        db.commit()
    return created


def direct_reports_of(db, user, employees) -> set:
    """Employee ids this user may approve, from the roster's manager link.

    Managers get their own reports. An admin's authority is handled before this is
    consulted, so it never needs a widened set here.
    """
    if not user or not user.employee_id or not isinstance(employees, list):
        return set()
    return {
        emp.get("id") for emp in employees
        if isinstance(emp, dict) and emp.get("managerId") == user.employee_id
    }
