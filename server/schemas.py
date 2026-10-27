"""Request bodies.

Named in camelCase to match the JSON the front end already produces, so the
client does not need a translation layer on the hot path.
"""

from datetime import datetime
from typing import Any

from pydantic import BaseModel, Field


class LoginRequest(BaseModel):
    identifier: str = Field(min_length=1, max_length=64)
    password: str = Field(min_length=1, max_length=200)


class PasswordChange(BaseModel):
    currentPassword: str = Field(min_length=1, max_length=200)
    newPassword: str = Field(min_length=1, max_length=200)


class StoreWrite(BaseModel):
    """A whole store document, plus the version it was derived from.

    `value` stays untyped on purpose. shared.js is the computation engine and the
    shapes evolve with it; re-declaring every record here would guarantee the two
    drift. Authorisation is enforced on the *change* in policy.py instead, which
    works whatever the shape turns out to be.
    """

    baseVersion: int = Field(ge=0)
    value: Any


class PunchIn(BaseModel):
    punchId: str = Field(min_length=8, max_length=64)
    kind: str = Field(pattern="^(in|out)$")
    employeeId: str | None = Field(default=None, max_length=32)
    clientCapturedAt: datetime | None = None
    latitude: float | None = Field(default=None, ge=-90, le=90)
    longitude: float | None = Field(default=None, ge=-180, le=180)
    accuracyM: int | None = Field(default=None, ge=0, le=100000)
