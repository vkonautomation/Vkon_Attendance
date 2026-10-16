"""One-time seeding of the authoritative backend.

Seeds two things:
  * the `users` table  -> bcrypt-hashed credentials (single source of truth for auth)
  * the `state_store`  -> a domain snapshot mirroring shared.js defaults so the
                          hydrated client cache looks identical to the old static app.

Idempotent: nothing is overwritten if it already exists, so a running container can
be restarted without wiping live data.
"""
import urllib.parse

from .db import get_db
from .config import STATE_KEYS
from .security import hash_password

# Documented dev passwords (unchanged from the old client-side demo so the portal
# still logs in turn-key). Production must change these + set SESSION_SECRET.
DEV_EMPLOYEE_PASSWORDS = {
    "EMP001": "mukesh123",
    "EMP002": "priya123",
    "EMP003": "chiranth123",
    "EMP004": "alex123",
}
DEV_ADMIN_PASSWORD = "admin123"
# Fixed dev TOTP seed (base32) so the demo admin can be enrolled in an auth app.
DEV_ADMIN_MFA_SECRET = "JBSWY3DPEHPK3PXP"


def _avatar_svg(name, skin_hex, hair_hex, shirt_hex, initials):
    svg = f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200" width="200" height="200">
    <defs>
      <linearGradient id="bg_{initials}" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stop-color="#1e293b"/>
        <stop offset="100%" stop-color="#0f172a"/>
      </linearGradient>
    </defs>
    <rect width="200" height="200" rx="24" fill="url(#bg_{initials})"/>
    <path d="M40 200 C40 152 70 142 100 142 C130 142 160 152 160 200 Z" fill="{shirt_hex}"/>
    <path d="M85 142 L100 162 L115 142 Z" fill="#ffffff" opacity="0.95"/>
    <rect x="88" y="122" width="24" height="25" fill="{skin_hex}"/>
    <ellipse cx="100" cy="94" rx="36" ry="44" fill="{skin_hex}"/>
    <path d="M60 84 C60 50 80 40 100 40 C120 40 140 50 140 84 C140 80 135 58 100 58 C65 58 60 80 60 84 Z" fill="{hair_hex}"/>
    <rect x="74" y="80" width="16" height="3.5" rx="1.5" fill="{hair_hex}"/>
    <rect x="110" y="80" width="16" height="3.5" rx="1.5" fill="{hair_hex}"/>
    <ellipse cx="82" cy="89" rx="5" ry="3.5" fill="#ffffff"/>
    <circle cx="82" cy="89" r="2.2" fill="#1e293b"/>
    <ellipse cx="118" cy="89" rx="5" ry="3.5" fill="#ffffff"/>
    <circle cx="118" cy="89" r="2.2" fill="#1e293b"/>
    <path d="M98 92 L96 104 L104 104" stroke="{hair_hex}" stroke-width="1.8" fill="none" opacity="0.6" stroke-linecap="round"/>
    <path d="M90 114 Q100 120 110 114" stroke="#c2410c" stroke-width="2.5" fill="none" stroke-linecap="round"/>
    <circle cx="166" cy="34" r="16" fill="#f97316" opacity="0.95"/>
    <text x="166" y="39" font-family="system-ui, sans-serif" font-size="11" font-weight="bold" fill="#ffffff" text-anchor="middle">{initials}</text>
  </svg>'''
    return "data:image/svg+xml;utf8," + urllib.parse.quote(svg)


# id, name, username, email, role, department, quota, geofence, enrolledAt, skin, hair, shirt, initials
_EMP_SPECS = [
    ("EMP001", "Mukesh Sharma", "mukesh", "mukesh.sharma@vkon.in", "Senior Full-Stack Engineer",
     "Engineering", 14, "required", "2026-01-10", "#d49b6a", "#1c1917", "#2563eb", "MS"),
    ("EMP002", "Priya Patel", "priya", "priya.patel@vkon.in", "UI/UX Product Designer",
     "Product", 14, "required", "2026-02-15", "#e0a97a", "#292524", "#7c3aed", "PP"),
    ("EMP003", "Chiranth Gowda", "chiranth", "chiranth.gowda@vkon.in", "Engineering Manager",
     "Operations", 14, "exempt", "2026-01-05", "#c68b59", "#0f172a", "#059669", "CG"),
    ("EMP004", "Alex Chen", "alex", "alex.chen@vkon.in", "DevOps & Cloud Architect",
     "Infrastructure", 14, "required", "2026-03-01", "#f0c29a", "#1e1b4b", "#0891b2", "AC"),
]


def _roster():
    employees = []
    for (eid, name, uname, email, role, dept, quota, geo, enrolled, skin, hair, shirt, ini) in _EMP_SPECS:
        employees.append({
            "id": eid,
            "name": name,
            "username": uname,
            "email": email,
            "role": role,
            "department": dept,
            "avatar": _avatar_svg(name, skin, hair, shirt, ini),
            "annualLeaveQuota": quota,
            "geofenceEnforcement": geo,
            "enrolledAt": enrolled,
        })
    return employees


_AVATARS = {e["id"]: e["avatar"] for e in _roster()}


def _records():
    return {
        "EMP001_2026-10-01": {
            "employeeId": "EMP001", "date": "2026-10-01", "status": "Present",
            "checkInTime": "09:12 AM", "checkOutTime": "06:14 PM", "duration": "9h 02m",
            "hoursDecimal": 9.03, "distance": 48, "locationType": "Office (Geofenced)",
            "bioVerified": True, "matchScore": 94, "selfieUrl": _AVATARS["EMP001"],
        },
        "EMP001_2026-10-02": {
            "employeeId": "EMP001", "date": "2026-10-02", "status": "Holiday",
            "checkInTime": "-", "checkOutTime": "-", "duration": "-", "hoursDecimal": 0,
            "distance": 0, "locationType": "Holiday (Gandhi Jayanti)", "bioVerified": False,
            "selfieUrl": None,
        },
        "EMP001_2026-10-06": {
            "employeeId": "EMP001", "date": "2026-10-06", "status": "Present",
            "checkInTime": "09:18 AM", "checkOutTime": "06:20 PM", "duration": "9h 02m",
            "hoursDecimal": 9.03, "distance": 52, "locationType": "Office (Geofenced)",
            "bioVerified": True, "matchScore": 95, "selfieUrl": _AVATARS["EMP001"],
        },
        "EMP002_2026-10-08": {
            "employeeId": "EMP002", "date": "2026-10-08", "status": "Present",
            "checkInTime": "09:15 AM", "checkOutTime": "-", "duration": "In Progress",
            "hoursDecimal": 0, "distance": 42, "locationType": "Office (Geofenced)",
            "bioVerified": True, "photoVerified": True, "matchScore": 95,
            "selfieUrl": _AVATARS["EMP002"],
        },
        "EMP002_2026-10-01": {
            "employeeId": "EMP002", "date": "2026-10-01", "status": "Present",
            "checkInTime": "09:28 AM", "checkOutTime": "06:30 PM", "duration": "9h 02m",
            "hoursDecimal": 9.03, "distance": 62, "locationType": "Office (Geofenced)",
            "bioVerified": True, "matchScore": 93, "selfieUrl": _AVATARS["EMP002"],
        },
    }


_HOLIDAYS = [
    {"id": "HOL-01", "date": "2026-10-02", "name": "Gandhi Jayanti", "type": "Declared Holiday"},
    {"id": "HOL-02", "date": "2026-10-20", "name": "Diwali Festival", "type": "Restricted Holiday"},
    {"id": "HOL-03", "date": "2026-10-21", "name": "Ayudha Puja / Dussehra", "type": "Restricted Holiday"},
    {"id": "HOL-04", "date": "2026-12-25", "name": "Christmas Day", "type": "Declared Holiday"},
    {"id": "HOL-05", "date": "2026-01-26", "name": "Republic Day", "type": "Declared Holiday"},
    {"id": "HOL-06", "date": "2026-08-15", "name": "Independence Day", "type": "Declared Holiday"},
]

_SETTINGS = {"name": "VKON Automation Tech Park", "lat": 12.9716, "lng": 77.5946, "radius": 500}
_QUOTAS = {"personalLeave": 14, "restrictedLeave": 2}
_MIN_WORK_POLICY = {"hours": 8, "minutes": 0, "totalMinutes": 480}


def _seed_users() -> None:
    with get_db() as db:
        exists = db.execute("SELECT 1 FROM users LIMIT 1").fetchone()
        if exists:
            return
        for (eid, name, uname, email, role, dept, quota, geo, enrolled, *_rest) in _EMP_SPECS:
            db.execute(
                """INSERT INTO users
                   (id, kind, name, username, employee_id, email, password_hash,
                    role_title, department, geofence_enforcement, annual_leave_quota,
                    enrolled_at, mfa_secret, mfa_enabled, active)
                   VALUES (?, 'employee', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 0, 1)""",
                (
                    eid, name, uname, eid, email,
                    hash_password(DEV_EMPLOYEE_PASSWORDS[eid]),
                    role, dept, geo, quota, enrolled,
                ),
            )
        db.execute(
            """INSERT INTO users
               (id, kind, name, username, employee_id, email, password_hash,
                role_title, department, geofence_enforcement, annual_leave_quota,
                enrolled_at, mfa_secret, mfa_enabled, active)
               VALUES ('ADMIN001', 'admin', 'VKON Executive Administrator', 'admin',
                       'ADMIN001', 'admin@vkon.in', ?, 'System Administrator',
                       'Administration', 'exempt', 0, '2026-01-01', ?, 1, 1)""",
            (hash_password(DEV_ADMIN_PASSWORD), DEV_ADMIN_MFA_SECRET),
        )


def _seed_state() -> None:
    from .store import has_state, set_state
    defaults = {
        STATE_KEYS["employees"]: _roster(),
        STATE_KEYS["records"]: _records(),
        STATE_KEYS["holidays"]: _HOLIDAYS,
        STATE_KEYS["settings"]: _SETTINGS,
        STATE_KEYS["leave_quotas"]: _QUOTAS,
        STATE_KEYS["min_work_policy"]: _MIN_WORK_POLICY,
        STATE_KEYS["wfh"]: [],
        STATE_KEYS["leaves"]: [],
        STATE_KEYS["regularisations"]: [],
    }
    for key, value in defaults.items():
        if not has_state(key):
            set_state(key, value)


def run_seed() -> None:
    _seed_users()
    _seed_state()
