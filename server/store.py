"""Read/write helpers for the JSON `state_store` table (server source of truth)."""
import json
import time
from typing import Any, Optional

from .db import get_db


def get_state(key: str, default: Any = None) -> Any:
    with get_db() as db:
        row = db.execute("SELECT value_json FROM state_store WHERE key = ?", (key,)).fetchone()
    if row is None:
        return default
    try:
        return json.loads(row["value_json"])
    except (json.JSONDecodeError, TypeError):
        return default


def set_state(key: str, value: Any) -> int:
    """Upsert a key's value, bumping and returning the new version."""
    now = time.time()
    payload = json.dumps(value)
    with get_db() as db:
        db.execute(
            """
            INSERT INTO state_store (key, value_json, version, updated_at)
            VALUES (?, ?, 1, ?)
            ON CONFLICT(key) DO UPDATE SET
                value_json = excluded.value_json,
                version    = state_store.version + 1,
                updated_at = excluded.updated_at
            """,
            (key, payload, now),
        )
        row = db.execute("SELECT version FROM state_store WHERE key = ?", (key,)).fetchone()
        return int(row["version"]) if row else 0


def has_state(key: str) -> bool:
    with get_db() as db:
        return db.execute("SELECT 1 FROM state_store WHERE key = ?", (key,)).fetchone() is not None
