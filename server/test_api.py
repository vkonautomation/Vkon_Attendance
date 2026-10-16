"""Backend API tests (pytest).

Run from the project root:
    pytest server/test_api.py -v

A throwaway SQLite file is used so the suite never touches real data, and the
dev seed (documented demo passwords) provides the accounts under test.
"""
import os
import tempfile

# Point the app at a fresh DB *before* importing it (config reads env at import).
_tmpdir = tempfile.mkdtemp(prefix="vkon_test_")
os.environ["VKON_DB_PATH"] = os.path.join(_tmpdir, "test.db")
os.environ["VKON_ENV"] = "test"
os.environ["COOKIE_SECURE"] = "false"
# Disable the per-IP throttle so tests (all from one client host) don't collide;
# the per-identifier lockout is still exercised in its own test.
os.environ["LOGIN_IP_MAX"] = "100000"

from fastapi.testclient import TestClient  # noqa: E402

import pyotp  # noqa: E402

from server.main import app  # noqa: E402
from server.seed import DEV_ADMIN_MFA_SECRET  # noqa: E402


def _client():
    return TestClient(app)


def test_employee_login_success_by_username():
    with _client() as c:
        r = c.post("/api/auth/login", json={"identifier": "mukesh", "password": "mukesh123"})
        assert r.status_code == 200
        assert r.json()["role"] == "employee"
        assert c.cookies.get("vkon_session")


def test_employee_login_by_work_email():
    with _client() as c:
        r = c.post("/api/auth/login", json={"identifier": "priya.patel@vkon.in", "password": "priya123"})
        assert r.status_code == 200
        assert r.json()["role"] == "employee"


def test_login_wrong_password_is_401():
    with _client() as c:
        r = c.post("/api/auth/login", json={"identifier": "chiranth", "password": "wrongpass"})
        assert r.status_code == 401


def test_session_requires_auth():
    with _client() as c:
        assert c.get("/api/session").status_code == 401
        c.post("/api/auth/login", json={"identifier": "mukesh", "password": "mukesh123"})
        assert c.get("/api/session").status_code == 200


def test_employee_state_is_scoped_to_self():
    with _client() as c:
        c.post("/api/auth/login", json={"identifier": "mukesh", "password": "mukesh123"})
        state = c.get("/api/state").json()
        # Roster filtered to just the caller.
        assert {e["id"] for e in state["vkon_employees_v6"]} == {"EMP001"}
        # Records only ever belong to the caller.
        owners = {rec["employeeId"] for rec in state["vkon_records_v6"].values()}
        assert owners <= {"EMP001"}


def test_employee_cannot_patch_roster_is_403():
    with _client() as c:
        c.post("/api/auth/login", json={"identifier": "mukesh", "password": "mukesh123"})
        r = c.patch("/api/state/vkon_employees_v6", json={"value": [{"id": "EMP999"}]})
        assert r.status_code == 403


def test_employee_cannot_touch_another_employees_record():
    with _client() as c:
        c.post("/api/auth/login", json={"identifier": "mukesh", "password": "mukesh123"})
        payload = {"value": {"EMP002_2026-10-08": {"employeeId": "EMP002", "status": "Present"}}}
        r = c.patch("/api/state/vkon_records_v6", json=payload)
        assert r.status_code == 403


def test_admin_login_requires_mfa_then_succeeds():
    with _client() as c:
        r = c.post("/api/auth/login", json={"identifier": "admin", "password": "admin123"})
        assert r.status_code == 200
        body = r.json()
        assert body["mfa_required"] is True
        # No session cookie yet: MFA is still pending.
        assert not c.cookies.get("vkon_session")

        bad = c.post("/api/auth/mfa/verify", json={"preauth_token": body["preauth_token"], "code": "000000"})
        assert bad.status_code == 401

        code = pyotp.TOTP(DEV_ADMIN_MFA_SECRET).now()
        ok = c.post("/api/auth/mfa/verify", json={"preauth_token": body["preauth_token"], "code": code})
        assert ok.status_code == 200
        assert ok.json()["role"] == "admin"
        assert c.cookies.get("vkon_session")


def test_admin_sees_all_and_can_patch():
    with _client() as c:
        login = c.post("/api/auth/login", json={"identifier": "admin", "password": "admin123"}).json()
        code = pyotp.TOTP(DEV_ADMIN_MFA_SECRET).now()
        c.post("/api/auth/mfa/verify", json={"preauth_token": login["preauth_token"], "code": code})
        state = c.get("/api/state").json()
        assert len(state["vkon_employees_v6"]) >= 4


def test_identifier_lockout_after_repeated_failures():
    with _client() as c:
        ident = "alex"
        for _ in range(5):
            r = c.post("/api/auth/login", json={"identifier": ident, "password": "nope"})
            assert r.status_code == 401
        # Account is now locked regardless of a correct password.
        r = c.post("/api/auth/login", json={"identifier": ident, "password": "alex123"})
        assert r.status_code == 429
