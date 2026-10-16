"""FastAPI application entrypoint.

Wires the auth + state routers, initializes + seeds SQLite on startup, and serves
the existing static frontend from the same origin (so the session cookie is
first-party and no CORS is required). The static mount is added LAST so it never
shadows an /api route.
"""
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

from .auth import router as auth_router
from .config import config
from .db import init_schema
from .seed import run_seed
from .state import router as state_router


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_schema()
    run_seed()
    yield


app = FastAPI(title="VKON Attendance API", version="1.0.0", lifespan=lifespan)

# API routers first.
app.include_router(auth_router)
app.include_router(state_router)


@app.exception_handler(Exception)
async def unhandled_exception_handler(request: Request, exc: Exception):
    # Never leak stack traces / internals to the client.
    return JSONResponse(status_code=500, content={"detail": "Internal server error"})


@app.get("/api/health")
def health():
    return {"status": "ok", "env": config.ENV}


# Static frontend (index.html, admin.html, styles.css, js/, ...). Mounted last.
app.mount("/", StaticFiles(directory=str(config.STATIC_DIR), html=True), name="static")
