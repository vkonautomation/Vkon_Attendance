"""Application assembly.

One container serves the API and the front end, so there is exactly one origin:
no CORS, no preflight round trip on a weak connection, and the session cookie is
first-party.

The static half is an explicit allow-list rather than a mount of the repository
root. The same rule the Dockerfile follows - ship the browser files and nothing
else - has to hold here too, or `GET /server/config.py` and `GET /.env` become the
backend's most likely disclosure.
"""

from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from starlette.middleware.sessions import SessionMiddleware

from . import config, db, seed
from .api import AuthError, router as api_router
from .policy import PolicyError

BASE_DIR = Path(__file__).resolve().parent.parent

# Files the browser is allowed to fetch from this origin. Anything not listed here
# is a 404, including this package's own source.
PUBLIC_FILES = {
    "/": "index.html",
    "/index.html": "index.html",
    "/admin.html": "admin.html",
    "/admin": "admin.html",
    "/styles.css": "styles.css",
    "/shared.js": "shared.js",
    "/app.js": "app.js",
    "/admin.js": "admin.js",
    "/manifest.webmanifest": "manifest.webmanifest",
}
# Whole directories that are public by prefix.
PUBLIC_DIRS = {"/assets": "assets", "/js": "js"}
# Extensionless probes that must 404 rather than fall through to index.html.
NEVER_SERVE = (".py", ".db", ".env", ".git", ".json", ".md", ".sqlite", ".txt", ".log")


def bootstrap() -> None:
    """Create the schema and the administrator, once, before the first request.

    A plain module-level function rather than code inside the handler, so the
    startup work reads as one unit and is callable on its own.
    """
    db.init_db()
    with db.session_scope() as session:
        generated = seed.ensure_admin(session)
    for line in config.warnings():
        print(f"[vkon] WARNING: {line}")
    if generated:
        print("[vkon] No VKON_ADMIN_PASSWORD was set, so the administrator "
              "account was created with a generated password. It is in "
              f"{seed.credentials_path()} - retrieve it, hand it out, then "
              "delete that file. It will not be printed again.")


def create_app() -> FastAPI:
    @asynccontextmanager
    async def _lifespan(_app: FastAPI):
        bootstrap()
        yield

    app = FastAPI(
        title="VKON Attendance",
        docs_url=None,        # no interactive API console on a public host
        redoc_url=None,
        openapi_url=None,
        lifespan=_lifespan,
    )

    app.add_middleware(
        SessionMiddleware,
        secret_key=config.SESSION_SECRET,
        session_cookie=config.COOKIE_NAME,
        max_age=config.SESSION_MAX_AGE_SECONDS,
        https_only=config.COOKIE_SECURE,
        # Lax: the cookie rides on a top-level navigation but not on a cross-site
        # POST, which is what makes the state-changing endpoints safe without a
        # separate CSRF token. Strict breaks nothing here either, and can be
        # switched on once nobody opens the console from an email link.
        same_site="lax",
    )

    @app.middleware("http")
    async def security_headers(request: Request, call_next):
        response = await call_next(request)
        headers = response.headers
        headers["X-Content-Type-Options"] = "nosniff"
        headers["X-Frame-Options"] = "SAMEORIGIN"
        headers["Referrer-Policy"] = "same-origin"
        headers["Permissions-Policy"] = "geolocation=(self)"
        # object-src/base-uri/frame-ancestors are locked down; script-src still
        # allows inline because index.html and admin.html carry inline handlers
        # and style attributes. Removing 'unsafe-inline' is a front-end task, not
        # a header task, and pretending otherwise would ship a broken CSP.
        #
        # The external origins below are exactly the ones the two HTML files
        # reference, and each is listed only under the directive it actually serves:
        #   cdnjs  - font-awesome stylesheet, and the .woff2 glyphs that stylesheet
        #            loads. Allowing only style-src would give icons as empty boxes.
        #   unpkg  - leaflet, for the admin console's map (js and css, both SRI-pinned).
        # Anything not named here is blocked, so an injected https:// link in a
        # stored value cannot pull code in.
        headers["Content-Security-Policy"] = (
            "default-src 'self'; "
            "script-src 'self' 'unsafe-inline' https://unpkg.com; "
            "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com "
            "https://cdnjs.cloudflare.com https://unpkg.com; "
            "font-src 'self' https://fonts.gstatic.com https://cdnjs.cloudflare.com data:; "
            "img-src 'self' data: https:; "
            "connect-src 'self' https://timeapi.io https://worldtimeapi.org "
            "https://nominatim.openstreetmap.org; "
            "object-src 'none'; base-uri 'self'; frame-ancestors 'self'; form-action 'self'"
        )
        return response

    @app.exception_handler(AuthError)
    async def _auth_error(_request: Request, exc: AuthError):
        payload = {"message": exc.message}
        if getattr(exc, "reason", None):
            payload["reason"] = exc.reason
        return JSONResponse(status_code=exc.code, content={"error": payload})

    @app.exception_handler(PolicyError)
    async def _policy_error(_request: Request, exc: PolicyError):
        return JSONResponse(status_code=exc.status_code,
                            content={"error": {"message": exc.message}})

    app.include_router(api_router)

    # --- static front end -----------------------------------------------------

    for mount, folder in PUBLIC_DIRS.items():
        target = BASE_DIR / folder
        if target.exists():
            app.mount(mount, StaticFiles(directory=str(target)), name=folder.lstrip("/"))

    @app.get("/{path:path}", include_in_schema=False)
    def serve_public(path: str):
        full_path = "/" + path
        if full_path.endswith(NEVER_SERVE) or path.startswith((".", "server/")):
            return JSONResponse(status_code=404, content={"error": {"message": "Not found."}})

        candidate = PUBLIC_FILES.get(full_path)
        if candidate:
            file = BASE_DIR / candidate
            if file.exists():
                return FileResponse(str(file))
            return JSONResponse(status_code=404, content={"error": {"message": "Not found."}})

        # Anything under a public directory is handled by the mounts above; if we
        # get here it was a directory request like /assets with no trailing slash.
        for mount, _folder in PUBLIC_DIRS.items():
            if full_path == mount:
                return RedirectResponse(url=mount + "/", status_code=307)

        return JSONResponse(status_code=404, content={"error": {"message": "Not found."}})

    return app


app = create_app()
