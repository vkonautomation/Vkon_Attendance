import re

# Regression guard for the static-app security hardening.
# Run from the project root:  py verify_security.py
FAILURES = []


def check(cond, msg):
    print(("PASS: " if cond else "FAIL: ") + msg)
    if not cond:
        FAILURES.append(msg)


# Two bases, because "what the browser can fetch" and "what the repository
# contains" are different sets and the scan has to cover both. Everything the
# portal loads now lives under public/; the deploy files stay at the root.
WEB = [
    "shared.js", "app.js", "admin.js", "index.html", "admin.html",
    "js/api.js", "js/password-change.js",
]
ROOT = [
    "Dockerfile", "docker-compose.yml", ".dockerignore", ".env.example", ".gitignore",
    # Added with the backend: these ship to the browser and to the image too, so a
    # burned credential in either would be published exactly like one in shared.js.
    "Dockerfile.backend", "requirements.txt",
]
src = {}
SHIPPED = WEB + ROOT
for f in WEB:
    with open("public/" + f, "r", encoding="utf-8") as fh:
        src[f] = fh.read()
for f in ROOT:
    with open(f, "r", encoding="utf-8") as fh:
        src[f] = fh.read()

print("=== VERIFYING SECURITY HARDENING ===")

# 1. No credential ships in the demo data.
check(not re.search(r'password\s*:\s*"[^"]+"', src["shared.js"]),
      "shared.js declares no password value")
# These values are burned in this project's history, so none of them may ever work
# as a password. They are allowed to appear in exactly one place: a deny list that
# refuses them. Anywhere else - a default, a demo row, a pre-filled field - is a
# leak, which is what this distinguishes.
DENY_LIST_LINE = re.compile(r"^\s*(//|#)?\s*(const|var|let)?\s*[A-Z_]*(BLOCKLIST|BANNED|DENY)[A-Z_]*\s*=", re.I)
for leak in ["mukesh123", "priya123", "chiranth123", "alex123", "admin123"]:
    offenders = [f for f in SHIPPED for ln in src[f].splitlines()
                 if leak in ln and not DENY_LIST_LINE.match(ln)]
    check(not offenders,
          f"'{leak}' appears only in a deny list " +
          (f"(found in {offenders[:2]})" if offenders else "or not at all"))

# 2. Sign-in failures stay generic.
check("Default accounts:" not in src["app.js"] and "Master credentials:" not in src["app.js"],
      "app.js login errors name no account")
check("Try mukesh" not in src["app.js"] and "Use admin" not in src["app.js"]
      and "Try admin /" not in src["admin.js"],
      "no toast suggests a working credential")
check("data-pass" not in src["index.html"] and "data-pass" not in src["admin.html"],
      "quick-fill buttons carry no password attribute")
check('adminP.value = "admin123"' not in src["app.js"]
      and 'adminOverlayPassword").value = "' not in src["admin.js"],
      "no script pre-fills a password")
check("admin / admin123" not in src["admin.html"],
      "admin.html UI text reveals no credential")

# 3. The client-side check is a marked demo, flagged, and on by default.
for needle in ["TEMPORARY DEMO AUTHENTICATION", "demoAuthEnabled()", "demoAuthenticate(",
               "DEMO_AUTH_UNAVAILABLE_MSG", '"unconfigured"', "DEMO_AUTH_FLAG_KEY"]:
    check(needle in src["shared.js"], f"shared.js contains {needle}")
# Demo sign-in is enabled by default; the only way to close it is the explicit
# per-browser kill switch, which must keep working. It is a fallback for the static
# build only: with a backend reachable, signIn() authenticates against the server.
check('return flag !== "off"' in src["shared.js"],
      "demo authentication is on by default")
check("function setDemoAuthFlag" in src["shared.js"],
      "a kill switch exists to turn demo authentication off again")
check("emp.password === pwd" not in src["app.js"] and "adminCreds.password ===" not in src["app.js"],
      "app.js no longer compares passwords inline")
check("emp.password === enteredPass" not in src["admin.js"],
      "admin.js no longer compares passwords inline")
# Both screens now go through signIn(), which asks the backend when one is present
# and only falls back to the demo check on a static host. The demo check must not
# be reachable directly from a screen again, or a server deployment would silently
# bypass real authentication.
check("demoAuthenticate(" not in src["app.js"] and "demoAuthenticate(" not in src["admin.js"],
      "neither screen calls the demo check directly")
check("await signIn(" in src["app.js"] and "await signIn(" in src["admin.js"],
      "both screens route sign-in through signIn(), which prefers the server")

# 4. No secret value in the compose file; secrets come from .env.
# A plain substring test would be wrong here: the backend service legitimately names
# SESSION_SECRET while explaining that its value lives in .env. What must not exist
# is a literal - so look only at real settings, and accept an unset key or a
# ${VAR} reference from the environment.
compose_settings = [ln for ln in src["docker-compose.yml"].splitlines()
                    if not ln.strip().startswith("#")]
compose_secret_refs = [ln.strip() for ln in compose_settings
                       if "SESSION_SECRET" in ln]
check(all(re.search(r"SESSION_SECRET\s*:\s*(\$\{.*)?$", ln)
          for ln in compose_secret_refs),
      "docker-compose.yml carries no session secret value, only a reference")
check("env_file" in src["docker-compose.yml"] and ".env" in src["docker-compose.yml"],
      "docker-compose.yml loads an untracked .env")
check(re.search(r"^SESSION_SECRET=\s*$", src[".env.example"], re.M) is not None
      and "change-me" not in src[".env.example"].lower(),
      ".env.example keeps SESSION_SECRET empty (placeholders only)")
check(".env" in src[".gitignore"] and ".env" in src[".dockerignore"],
      ".env is ignored by both git and docker")

# 5. Ignore rules cover secrets, data, venvs and the database.
for token in [".env", "data/", ".venv/", "venv/", "*.db", "*.sqlite", "photos/", ".scratch/"]:
    check(token in src[".gitignore"], f".gitignore covers {token}")
# "server/" is deliberately absent from this list: Docker honours one ignore file per
# build and the backend image needs that directory, so it can no longer be ignored.
# Saying so in a comment used to satisfy a substring test, which is why the control
# is now asserted where it actually lives - in the static Dockerfile's COPY list.
for token in [".git/", "data/", ".env", ".venv/", "node_modules/", "__pycache__/",
              ".pytest_cache/", "test_", "verify_", ".scratch/"]:
    check(token in src[".dockerignore"], f".dockerignore excludes {token}")

# 6. Image serves the public folder only, on a supported Python, data outside it.
m = re.search(r"FROM python:(\d+)\.(\d+)", src["Dockerfile"])
check(m is not None and (int(m.group(1)), int(m.group(2))) >= (3, 11),
      "Dockerfile base image is Python 3.11 or newer")
check("COPY . " not in src["Dockerfile"] and "COPY .\n" not in src["Dockerfile"],
      "Dockerfile does not copy the whole repository")
check("/srv/public" in src["Dockerfile"] and '--directory", "/srv/public"' in src["Dockerfile"],
      "Dockerfile serves only the dedicated public folder")
check("/var/lib/vkon" in src["Dockerfile"] and "/var/lib/vkon" in src["docker-compose.yml"],
      "the data volume lives outside the served folder")
check("USER vkon" in src["Dockerfile"], "the container does not run as root")

# The static image must not gain the backend source by accident - that is the whole
# reason dropping the .dockerignore rule was safe.
static_copies_server = [ln for ln in src["Dockerfile"].splitlines()
                        if ln.strip().startswith("COPY") and "server" in ln]
check(not static_copies_server,
      "the static image never copies the backend source"
      + (f" ({static_copies_server[:1]})" if static_copies_server else ""))

# Dockerfile.backend is a second image with the same obligations. Asserting them
# here rather than trusting that it was written carefully is what keeps the two
# images from drifting apart later.
mb = re.search(r"FROM python:(\d+)\.(\d+)", src["Dockerfile.backend"])
check(mb is not None and (int(mb.group(1)), int(mb.group(2))) >= (3, 11),
      "Dockerfile.backend base image is Python 3.11 or newer")
check("COPY . " not in src["Dockerfile.backend"] and "COPY .\n" not in src["Dockerfile.backend"],
      "Dockerfile.backend does not copy the whole repository")
check("USER vkon" in src["Dockerfile.backend"],
      "the backend container does not run as root")
check("/var/lib/vkon" in src["Dockerfile.backend"],
      "the backend writes data outside the served folder")
check(not any(ln.strip().startswith("COPY") and ".env" in ln
              for ln in src["Dockerfile.backend"].splitlines()),
      "Dockerfile.backend does not copy .env into the image")
# Secrets reach the backend through env_file only, never as a baked-in value.
backend_env = [ln.strip() for ln in src["Dockerfile.backend"].splitlines()
               if "SESSION_SECRET" in ln]
check(not backend_env,
      "Dockerfile.backend sets no session secret of its own"
      + (f" ({backend_env[:1]})" if backend_env else ""))

if FAILURES:
    print(f"\n>>> {len(FAILURES)} SECURITY CHECK(S) FAILED <<<")
    raise SystemExit(1)
print("\n>>> ALL SECURITY HARDENING CHECKS VERIFIED SUCCESSFULLY <<<")
