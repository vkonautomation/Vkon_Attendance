"""Backend behaviour tests: identity, write authority, concurrency, punches.

Run with  .venv/Scripts/python -m pytest test_backend.py -q

The interesting cases are the negative ones. A backend that stores whatever any
browser sends it is a shared hard drive, so most of this file asserts that a
tampered client is refused: another employee's rows, an approval outcome recorded
by the person requesting it, a roster edit from a non-admin, a stale write that
would clobber a colleague.
"""

import os
import re
import shutil
import tempfile

# Must be set before server.config is imported: configuration is read once.
# VKON_TEST_DATA_DIR lets CI or a sandboxed shell point this at a writable path;
# it is removed at the end of the run either way.
_DATA = os.environ.get("VKON_TEST_DATA_DIR") or tempfile.mkdtemp(prefix="vkon-test-")
os.makedirs(_DATA, exist_ok=True)
# A supplied directory may survive from an earlier run; a database without its
# matching credentials file would make every login assertion lie.
for _stale in ("test.db", "test.db-wal", "test.db-shm", "initial-credentials.txt"):
    try:
        os.remove(os.path.join(_DATA, _stale))
    except FileNotFoundError:
        pass
os.environ["VKON_ENV"] = "development"
os.environ["VKON_DATA_DIR"] = _DATA
os.environ["VKON_DB_PATH"] = os.path.join(_DATA, "test.db")
os.environ["VKON_ADMIN_USERNAME"] = "admin"
os.environ["VKON_ADMIN_PASSWORD"] = "Correct-Horse-Battery-9"
os.environ["VKON_LOGIN_MAX_ATTEMPTS"] = "5"

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from server import db as db_module  # noqa: E402
from server import security, seed  # noqa: E402
from server.main import app  # noqa: E402
from server.models import PunchEvent, ROLE_MANAGER, User  # noqa: E402

ADMIN_PW = os.environ["VKON_ADMIN_PASSWORD"]
_USING_TEMP = not os.environ.get("VKON_TEST_DATA_DIR")

ROSTER = [
    {"id": "EMP001", "name": "Mukesh Sharma", "username": "mukesh", "managerId": "EMP003"},
    {"id": "EMP002", "name": "Priya Patel", "username": "priya", "managerId": "EMP003"},
    {"id": "EMP003", "name": "Ravi Kumar", "username": "ravi", "managerId": ""},
    # Reports to nobody, so it is the clean "not your direct report" case.
    {"id": "EMP004", "name": "Devan Nair", "username": "devan", "managerId": ""},
]


@pytest.fixture(scope="module", autouse=True)
def _clean_data_dir():
    yield
    if _USING_TEMP:
        shutil.rmtree(_DATA, ignore_errors=True)


@pytest.fixture(scope="module")
def client():
    with TestClient(app) as test_client:
        yield test_client


@pytest.fixture(scope="module")
def admin(client):
    r = client.post("/api/auth/login", json={"identifier": "admin", "password": ADMIN_PW})
    assert r.status_code == 200, r.text
    return r.json()


@pytest.fixture()
def employee_roster_published(client, admin):
    """Push the roster up, which is what provisions employee accounts."""
    r = client.put("/api/state/vkon_employees_v6",
                   json={"baseVersion": _version(client, "vkon_employees_v6"), "value": ROSTER})
    assert r.status_code == 200, r.text
    return r.json()["version"]


def _version(client, key):
    r = client.get("/api/state")
    if r.status_code != 200:
        return 0
    doc = r.json()["stores"].get(key)
    return doc["version"] if doc else 0


def _login(client, identifier, password):
    return client.post("/api/auth/login", json={"identifier": identifier, "password": password})


def _employee_client(client, employee_id, username, new_password="Mukesh-Long-Pass-1"):
    """A signed-in employee past the forced password change.

    Safe to call more than once: after the first rotation the temporary password
    from the credentials file no longer works, so fall back to the rotated one.
    """
    creds = {}
    path = os.path.join(_DATA, seed.CREDENTIALS_FILE_NAME)
    with open(path, encoding="utf-8") as handle:
        for line in handle:
            if line.startswith("#") or not line.strip():
                continue
            ident, pw, note = line.rstrip("\n").split("\t")
            creds[ident] = pw

    emp = TestClient(app)
    r = _login(emp, username, creds[username])
    if r.status_code == 401:
        r = _login(emp, username, new_password)
        assert r.status_code == 200, r.text
        return emp
    assert r.status_code == 200, r.text
    assert r.json()["employeeId"] == employee_id
    assert r.json()["mustChangePassword"] is True
    # Forced: the temporary password may not be used for anything but a change.
    blocked = emp.get("/api/state")
    assert blocked.status_code == 403
    assert blocked.json()["error"]["reason"] == "password_change_required"
    changed = emp.post("/api/auth/password",
                       json={"currentPassword": creds[username], "newPassword": new_password})
    assert changed.status_code == 200, changed.text
    return emp


def _make_manager(employee_id):
    """Promote in the database directly: role changes are an admin action, and
    the endpoint for that is deliberately not part of this phase."""
    with db_module.session_scope() as s:
        s.get(User, employee_id).role = ROLE_MANAGER


def _manager_client():
    mgr = TestClient(app)
    assert _login(mgr, "ravi", "Ravi-Long-Pass-2").status_code == 200
    return mgr


# ---------------------------------------------------------------- health & auth

def test_health_is_public_and_says_nothing_about_data(client):
    r = client.get("/api/state")
    assert r.status_code == 401, "state must not be readable anonymously"

    h = client.get("/api/health")
    assert h.status_code == 200
    body = h.json()
    assert body["status"] == "ok"
    assert "accounts" not in str(body).lower()


def test_login_does_not_reveal_whether_an_account_exists(client):
    wrong_password = _login(client, "admin", "definitely-not-it")
    no_such_user = _login(client, "nosuchperson", "definitely-not-it")
    assert wrong_password.status_code == no_such_user.status_code == 401
    assert wrong_password.json()["error"]["message"] == no_such_user.json()["error"]["message"]


def test_login_by_employee_id_works(client, employee_roster_published):
    """The portal has always accepted EMP003 as well as a username; keep that.

    Uses ravi so EMP001's freshly-generated credentials stay intact for the tests
    that follow.
    """
    with db_module.session_scope() as s:
        ravi = s.get(User, "EMP003")
        ravi.must_change_password = False
        ravi.password_hash = security.hash_password("Ravi-Long-Pass-2")
    r = _login(TestClient(app), "EMP003", "Ravi-Long-Pass-2")
    assert r.status_code == 200
    assert r.json()["employeeId"] == "EMP003"


def test_repeated_failures_lock_the_account(client):
    guard = TestClient(app)
    from server.security import login_guard
    login_guard.clear()
    for _ in range(5):
        assert _login(guard, "admin", "wrong-password-here").status_code == 401
    locked = _login(guard, "admin", ADMIN_PW)
    assert locked.status_code == 429
    assert locked.json()["error"]["retryAfter"] > 0
    login_guard.clear()


def test_password_blocklist_rejects_burned_credentials(client):
    """These values are in this project's git history and demo screenshots."""
    r = client.post("/api/auth/password",
                    json={"currentPassword": ADMIN_PW, "newPassword": "admin123"})
    assert r.status_code == 400
    assert "blocklist" in r.json()["error"]["message"]


# ------------------------------------------------------------------- write rules

def test_publishing_the_roster_provisions_accounts(client, employee_roster_published):
    path = os.path.join(_DATA, seed.CREDENTIALS_FILE_NAME)
    text = open(path, encoding="utf-8").read()
    for username in ("mukesh", "priya", "ravi", "devan"):
        assert re.search(rf"^{username}\t", text, re.M), f"{username} has no credential line"
    with db_module.session_scope() as s:
        assert s.get(User, "EMP001").must_change_password is True
        assert s.get(User, "EMP001").manager_id == "EMP003"


def test_credentials_file_is_owner_only(client, employee_roster_published):
    """POSIX modes are what the container honours; Windows ignores chmod here."""
    if os.name != "posix":
        pytest.skip("owner-only modes are enforced in the Linux deployment image")
    import stat
    path = os.path.join(_DATA, seed.CREDENTIALS_FILE_NAME)
    mode = stat.S_IMODE(os.stat(path).st_mode)
    assert mode & 0o077 == 0, f"{oct(mode)} is readable by group or others"


def test_employee_cannot_write_the_roster(client, employee_roster_published):
    emp = _employee_client(client, "EMP001", "mukesh")
    r = emp.put("/api/state/vkon_employees_v6",
                json={"baseVersion": employee_roster_published, "value": []})
    assert r.status_code == 403
    assert "administrator" in r.json()["error"]["message"]


def test_employee_can_write_their_own_record(client, employee_roster_published):
    emp = _employee_client(client, "EMP001", "mukesh")
    mine = {"EMP001_2026-10-27": {"employeeId": "EMP001", "date": "2026-10-27",
                                  "status": "Present", "checkInTime": "09:00 AM"}}
    r = emp.put("/api/state/vkon_records_v6", json={"baseVersion": 0, "value": mine})
    assert r.status_code == 200, r.text
    assert r.json()["version"] == 1


def test_employee_cannot_touch_another_employees_record(client, employee_roster_published):
    emp = _employee_client(client, "EMP001", "mukesh")
    version = emp.get("/api/state").json()["stores"]["vkon_records_v6"]["version"]
    tampered = {"EMP002_2026-10-27": {"employeeId": "EMP002", "status": "Present"}}
    r = emp.put("/api/state/vkon_records_v6", json={"baseVersion": version, "value": tampered})
    assert r.status_code == 403
    assert "EMP002" in r.json()["error"]["message"]


def test_employee_cannot_approve_their_own_request(client, employee_roster_published):
    emp = _employee_client(client, "EMP001", "mukesh")
    stores = emp.get("/api/state").json()["stores"]
    version = stores["vkon_wfh_v6"]["version"] if "vkon_wfh_v6" in stores else 0
    self_approved = [{"id": "WFH-900", "employeeId": "EMP001", "date": "2026-11-02",
                      "status": "Approved"}]
    r = emp.put("/api/state/vkon_wfh_v6", json={"baseVersion": version, "value": self_approved})
    assert r.status_code == 403, "an employee must not be able to approve their own WFH"


def test_a_decided_request_cannot_be_deleted(client, employee_roster_published):
    """An approver may decide a request, not erase the decision afterwards.

    Tested through a manager rather than an admin on purpose: an admin can
    legitimately resolve or undo anything, which is what the admin role is for.
    """
    admin_client = TestClient(app)
    assert _login(admin_client, "admin", ADMIN_PW).status_code == 200
    approved = [{"id": "WFH-901", "employeeId": "EMP002", "date": "2026-11-03",
                 "status": "Approved"}]
    r = admin_client.put("/api/state/vkon_wfh_v6", json={"baseVersion": 0, "value": approved})
    assert r.status_code == 200

    _make_manager("EMP003")
    mgr = _manager_client()
    doc = mgr.get("/api/state").json()["stores"]["vkon_wfh_v6"]
    erased = mgr.put("/api/state/vkon_wfh_v6",
                     json={"baseVersion": doc["version"], "value": []})
    assert erased.status_code == 403
    assert "cannot be deleted" in erased.json()["error"]["message"]


def test_manager_approves_only_their_own_reports(client, employee_roster_published):
    """EMP003 is the manager of EMP001 and EMP002 in the seeded roster."""
    _make_manager("EMP003")
    mgr = _manager_client()

    doc = mgr.get("/api/state").json()["stores"].get("vkon_wfh_v6", {})
    existing, version = doc.get("value", []), doc.get("version", 0)
    pending = existing + [{"id": "WFH-902", "employeeId": "EMP002", "date": "2026-11-04",
                           "status": "Pending Manager"}]
    r1 = mgr.put("/api/state/vkon_wfh_v6", json={"baseVersion": version, "value": pending})
    assert r1.status_code == 200, r1.text

    decided = [dict(row, status="Approved") if row["id"] == "WFH-902" else row
               for row in pending]
    r2 = mgr.put("/api/state/vkon_wfh_v6",
                 json={"baseVersion": r1.json()["version"], "value": decided})
    assert r2.status_code == 200, r2.text

    # EMP004 reports to nobody, so their request is out of scope for this manager.
    out_of_scope = decided + [{"id": "WFH-903", "employeeId": "EMP004",
                               "date": "2026-11-05", "status": "Approved"}]
    refused = mgr.put("/api/state/vkon_wfh_v6",
                      json={"baseVersion": r2.json()["version"], "value": out_of_scope})
    assert refused.status_code == 403
    assert "EMP004" in refused.json()["error"]["message"]


def test_local_only_and_unknown_keys_are_refused(client):
    admin_client = TestClient(app)
    assert _login(admin_client, "admin", ADMIN_PW).status_code == 200
    theme = admin_client.put("/api/state/vkon_theme_v6", json={"baseVersion": 0, "value": "dark"})
    assert theme.status_code == 400
    unknown = admin_client.put("/api/state/vkon_not_a_real_store_v9",
                               json={"baseVersion": 0, "value": {}})
    assert unknown.status_code == 400


def test_stale_write_conflicts_instead_of_clobbering(client):
    admin_client = TestClient(app)
    assert _login(admin_client, "admin", ADMIN_PW).status_code == 200
    first = admin_client.put("/api/state/vkon_holidays_v6",
                             json={"baseVersion": 0, "value": [{"date": "2026-10-02"}]})
    assert first.status_code == 200
    stale = admin_client.put("/api/state/vkon_holidays_v6",
                             json={"baseVersion": 0, "value": [{"date": "2026-12-25"}]})
    assert stale.status_code == 409
    body = stale.json()["error"]
    assert body["currentVersion"] == 1
    assert body["currentValue"] == [{"date": "2026-10-02"}], "conflict must return live data"


# ---------------------------------------------------------------------- punches

def test_punch_is_recorded_with_the_server_clock_and_day(client, employee_roster_published):
    emp = _employee_client(client, "EMP001", "mukesh")
    r = emp.post("/api/punches", json={
        "punchId": "aaaaaaaa-1111-2222-3333-444444444444", "kind": "in",
        "latitude": 12.9716, "longitude": 77.5946, "accuracyM": 12,
    })
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["insideGeofence"] is True
    assert body["distanceM"] < 5
    assert re.match(r"^\d{4}-\d{2}-\d{2}$", body["istDate"])
    assert re.match(r"^\d{1,2}:\d{2} [AP]M$", body["serverTime"])


def test_replayed_punch_does_not_double_book(client, employee_roster_published):
    """The whole point of the local-first queue: a retry over a flaky link lands once."""
    emp = _employee_client(client, "EMP001", "mukesh")
    payload = {"punchId": "bbbbbbbb-1111-2222-3333-444444444444", "kind": "in",
               "latitude": 12.9716, "longitude": 77.5946, "accuracyM": 15}
    first = emp.post("/api/punches", json=payload)
    replay = emp.post("/api/punches", json=payload)
    assert first.status_code == replay.status_code == 200
    assert replay.json()["duplicate"] is True
    with db_module.session_scope() as s:
        rows = s.query(PunchEvent).filter_by(punch_id=payload["punchId"]).count()
        assert rows == 1


def test_a_coarse_gps_fix_is_recorded_but_not_blessed(client, employee_roster_published):
    emp = _employee_client(client, "EMP001", "mukesh")
    r = emp.post("/api/punches", json={
        "punchId": "cccccccc-1111-2222-3333-444444444444", "kind": "in",
        "latitude": 12.9716, "longitude": 77.5946, "accuracyM": 5000,
    })
    body = r.json()
    assert body["insideGeofence"] is False
    assert "coarser" in body["note"]


def test_punch_for_someone_else_is_refused(client, employee_roster_published):
    emp = _employee_client(client, "EMP001", "mukesh")
    r = emp.post("/api/punches", json={
        "punchId": "dddddddd-1111-2222-3333-444444444444", "kind": "in",
        "employeeId": "EMP002", "latitude": 12.9716, "longitude": 77.5946, "accuracyM": 10,
    })
    assert r.status_code == 403


def test_punch_list_is_scoped_to_the_caller(client, employee_roster_published):
    emp = _employee_client(client, "EMP001", "mukesh")
    mine = emp.get("/api/punches").json()["punches"]
    assert mine, "expected the punches recorded by earlier tests"
    assert {p["employeeId"] for p in mine} == {"EMP001"}


# ------------------------------------------------------ forced first sign-in

def _temp_password(username):
    path = os.path.join(_DATA, seed.CREDENTIALS_FILE_NAME)
    with open(path, encoding="utf-8") as handle:
        for line in handle:
            if line.startswith("#") or not line.strip():
                continue
            ident, pw, _note = line.rstrip("\n").split("\t")
            if ident == username:
                return pw
    raise AssertionError(f"{username} has no credential line")


def test_a_temporary_password_opens_the_door_to_nothing_but_a_change(client):
    """The gate the client's password-change dialog exists for.

    Without it a new employee signs in with the password on the paper handed to
    them, /api/state answers 403, and the portal looks empty and broken rather
    than guarded.
    """
    temp = _temp_password("devan")
    fresh = TestClient(app)
    r = _login(fresh, "devan", temp)
    assert r.status_code == 200, r.text
    assert r.json()["mustChangePassword"] is True

    for path in ("/api/state", "/api/punches"):
        blocked = fresh.get(path) if path == "/api/state" else fresh.post(path, json={
            "punchId": "eeeeeeee-1111-2222-3333-444444444444", "kind": "in"})
        assert blocked.status_code == 403, f"{path} must be closed until the change"
        assert blocked.json()["error"]["reason"] == "password_change_required"

    # The auth routes stay reachable, or the account could not fix itself.
    assert fresh.get("/api/auth/me").status_code == 200
    wrong = fresh.post("/api/auth/password",
                        json={"currentPassword": "not-the-temp-one", "newPassword": "Devan-Long-Pass-3"})
    assert wrong.status_code == 401
    weak = fresh.post("/api/auth/password",
                      json={"currentPassword": temp, "newPassword": "short"})
    assert weak.status_code == 400
    assert fresh.post("/api/auth/password",
                      json={"currentPassword": temp, "newPassword": "Devan-Long-Pass-3"}).status_code == 200
    assert fresh.get("/api/state").status_code == 200, "the change must unlock the data"


def test_the_temporary_password_stops_working_after_the_change(client):
    """Rotation is not a suggestion, and the issued password is single-use."""
    fresh = TestClient(app)
    assert _login(fresh, "devan", _temp_password("devan")).status_code == 401
    r = _login(fresh, "devan", "Devan-Long-Pass-3")
    assert r.status_code == 200, r.text
    assert r.json()["mustChangePassword"] is False


# ------------------------------------------------- static serving stays locked

@pytest.mark.parametrize("path", [
    "/server/config.py", "/server/main.py", "/.env", "/.env.example",
    "/requirements.txt", "/.git/config", "/Dockerfile", "/test_backend.py",
    "/data/test.db",
])
def test_private_paths_are_not_served(client, path):
    assert client.get(path).status_code == 404, f"{path} must not be downloadable"


def test_the_front_end_is_still_served(client):
    index = client.get("/")
    assert index.status_code == 200
    assert "text/html" in index.headers["content-type"]
    assert client.get("/app.js").status_code == 200
    assert client.get("/js/day-popover.js").status_code == 200
    # The adapter must come from the same origin as the page, or the session cookie
    # would be third-party and the browser would refuse to send it.
    assert client.get("/js/api.js").status_code == 200
    assert client.get("/js/password-change.js").status_code == 200


def test_security_headers_are_present(client):
    h = client.get("/").headers
    assert h["x-content-type-options"] == "nosniff"
    assert "frame-ancestors 'self'" in h["content-security-policy"]
    assert "object-src 'none'" in h["content-security-policy"]


def _directive(csp: str, name: str) -> str:
    for part in csp.split(";"):
        tokens = part.strip().split()
        if tokens and tokens[0] == name:
            return " ".join(tokens[1:])
    return ""


def test_the_csp_permits_every_origin_the_pages_reference(client):
    """A CSP written from the spec rather than from the HTML ships a broken site.

    The first version of this server blocked font-awesome and leaflet: every icon
    rendered as an empty box and the admin map never loaded, with nothing failing on
    the server side to say so. So read the origins out of the actual files and hold
    the header to them, in the directive that each one is used in.
    """
    csp = client.get("/").headers["content-security-policy"]
    patterns = {
        "script-src": r'<script[^>]+src="(https://[^/"]+)',
        "style-src": r'<link[^>]+rel="stylesheet"[^>]+href="(https://[^/"]+)',
    }
    checked = 0
    for page in ("index.html", "admin.html"):
        with open(os.path.join(os.getcwd(), page), encoding="utf-8") as handle:
            html = handle.read()
        for directive, pattern in patterns.items():
            for origin in set(re.findall(pattern, html)):
                host = origin.split("://")[1]
                assert host in _directive(csp, directive), \
                    f"{page} loads {origin} but {directive} does not allow it"
                checked += 1
    assert checked >= 2, "the pages are expected to reference some CDN assets"

    # Not derivable from the HTML: the glyphs are fetched by the font-awesome sheet
    # itself, so a style-src-only allowance still shows icons as empty boxes.
    assert "https://cdnjs.cloudflare.com" in _directive(csp, "font-src"), \
        "font-awesome's .woff2 files need font-src as well as style-src"


def test_the_csp_does_not_open_more_than_the_pages_need(client):
    """The counterpart of the above: allowing the named CDNs must not slide into a
    wildcard, or the header stops being a control at all."""
    allowed = {"fonts.googleapis.com", "fonts.gstatic.com",
               "cdnjs.cloudflare.com", "unpkg.com", "timeapi.io",
               "worldtimeapi.org", "nominatim.openstreetmap.org"}
    csp = client.get("/").headers["content-security-policy"]
    for directive in ("script-src", "style-src", "font-src", "connect-src"):
        value = _directive(csp, directive)
        assert "*" not in value, f"{directive} contains a wildcard"
        for host in re.findall(r"https?://([^\s;]+)", value):
            assert host in allowed, f"{directive} allows {host}, which the app never uses"
    assert "default-src 'self'" in csp
    assert "object-src 'none'" in csp
