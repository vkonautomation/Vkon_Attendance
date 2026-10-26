import re

# Regression guard for the static-app security hardening.
# Run from the project root:  py verify_security.py
FAILURES = []


def check(cond, msg):
    print(("PASS: " if cond else "FAIL: ") + msg)
    if not cond:
        FAILURES.append(msg)


SHIPPED = [
    "shared.js", "app.js", "admin.js", "index.html", "admin.html",
    "Dockerfile", "docker-compose.yml", ".dockerignore", ".env.example", ".gitignore",
]
src = {}
for f in SHIPPED:
    with open(f, "r", encoding="utf-8") as fh:
        src[f] = fh.read()
everything = "".join(src.values())

print("=== VERIFYING SECURITY HARDENING ===")

# 1. No credential ships in the demo data.
check(not re.search(r'password\s*:\s*"[^"]+"', src["shared.js"]),
      "shared.js declares no password value")
for leak in ["mukesh123", "priya123", "chiranth123", "alex123", "admin123"]:
    check(leak not in everything, f"'{leak}' appears in no shipped file")

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

# 3. The client-side check is a marked demo, flagged, and off by default.
for needle in ["TEMPORARY DEMO AUTHENTICATION", "demoAuthEnabled()", "demoAuthenticate(",
               "DEMO_AUTH_UNAVAILABLE_MSG", '"unconfigured"', "_isLocalOrigin()"]:
    check(needle in src["shared.js"], f"shared.js contains {needle}")
check('h === "localhost"' in src["shared.js"] and 'protocol === "file:"' in src["shared.js"],
      "demo flag turns itself on only for local origins")
check("emp.password === pwd" not in src["app.js"] and "adminCreds.password ===" not in src["app.js"],
      "app.js no longer compares passwords inline")
check("emp.password === enteredPass" not in src["admin.js"],
      "admin.js no longer compares passwords inline")
check("demoAuthenticate(" in src["app.js"] and "demoAuthenticate(" in src["admin.js"],
      "both screens route sign-in through the single demo check")

# 4. No placeholder secret in the compose file; secrets come from .env.
check("SESSION_SECRET" not in src["docker-compose.yml"],
      "docker-compose.yml carries no session secret")
check("env_file" in src["docker-compose.yml"] and ".env" in src["docker-compose.yml"],
      "docker-compose.yml loads an untracked .env")
check(re.search(r"^SESSION_SECRET=\s*$", src[".env.example"], re.M) is not None
      and "change-me" not in src[".env.example"].lower(),
      ".env.example keeps SESSION_SECRET empty (placeholders only)")
check(".env" in src[".gitignore"] and ".env" in src[".dockerignore"],
      ".env is ignored by both git and docker")

# 5. Ignore rules cover secrets, data, venvs and the database.
for token in [".env", "data/", ".venv/", "venv/", "*.db", "*.sqlite", "photos/"]:
    check(token in src[".gitignore"], f".gitignore covers {token}")
for token in [".git/", "data/", ".env", ".venv/", "node_modules/", "__pycache__/",
              ".pytest_cache/", "test_", "verify_", "server/"]:
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

if FAILURES:
    print(f"\n>>> {len(FAILURES)} SECURITY CHECK(S) FAILED <<<")
    raise SystemExit(1)
print("\n>>> ALL SECURITY HARDENING CHECKS VERIFIED SUCCESSFULLY <<<")
