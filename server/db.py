"""SQLite access: schema creation + a small connection helper."""
import sqlite3
from contextlib import contextmanager
from typing import Iterator

from .config import config

SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
    id                   TEXT PRIMARY KEY,
    kind                 TEXT NOT NULL,            -- 'employee' | 'admin'
    name                 TEXT,
    username             TEXT,
    employee_id          TEXT,
    email                TEXT,
    password_hash        TEXT NOT NULL,
    role_title           TEXT,
    department           TEXT,
    geofence_enforcement TEXT,
    annual_leave_quota   INTEGER,
    enrolled_at          TEXT,
    mfa_secret           TEXT,
    mfa_enabled          INTEGER NOT NULL DEFAULT 0,
    active               INTEGER NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username   ON users(username);
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email      ON users(email);
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_employee   ON users(employee_id);

CREATE TABLE IF NOT EXISTS sessions (
    token_hash         TEXT PRIMARY KEY,
    user_id            TEXT NOT NULL,
    created_at         REAL NOT NULL,
    last_seen          REAL NOT NULL,
    expires_at         REAL NOT NULL,
    absolute_expires_at REAL NOT NULL,
    mfa_verified       INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS state_store (
    key        TEXT PRIMARY KEY,
    value_json TEXT NOT NULL,
    version    INTEGER NOT NULL DEFAULT 0,
    updated_at REAL
);

CREATE TABLE IF NOT EXISTS login_attempts (
    bucket       TEXT PRIMARY KEY,   -- 'ip:<addr>' or 'id:<identifier>'
    count        INTEGER NOT NULL DEFAULT 0,
    first_at     REAL,
    locked_until REAL
);
"""


def init_schema() -> None:
    config.DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    with get_db() as db:
        db.executescript(SCHEMA)


@contextmanager
def get_db() -> Iterator[sqlite3.Connection]:
    config.DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(config.DB_PATH), timeout=30)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA journal_mode = WAL")
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()
