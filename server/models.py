"""Tables.

The split is deliberate, and it is the whole point of adding a server:

  users         Server-owned identity. Credentials never live in a JSON blob the
                browser can rewrite, which was the single largest weakness of the
                static build.

  punch_events  Append-only evidence stamped by the server clock, not the phone's.
                Idempotent on a client-generated punch_id so a queued punch that
                retries over a flaky link lands exactly once.

  store_docs    One row per existing client store key (records, wfh, leaves...).
                The front end already treats each of these as a single JSON
                document, so this maps one-to-one onto getStore/setStore and keeps
                270 synchronous call sites working untouched. Version is bumped on
                every write and checked on the next one: optimistic concurrency,
                so two admins editing the roster cannot silently clobber each
                other.

  audit_entries Who changed what. An approval workflow is not defensible in a
                payroll dispute without it.

Normalising store_docs into relational tables is the obvious next step and is
deliberately not done here: reporting queries would get faster, but nothing about
correctness changes until the client stops being the author of its own history.
"""

from datetime import datetime, timezone

from sqlalchemy import (
    Boolean, DateTime, Float, ForeignKey, Index, Integer, JSON, String, Text, UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column

from .db import Base

ROLE_EMPLOYEE = "employee"
ROLE_MANAGER = "manager"
ROLE_ADMIN = "admin"
ROLES = (ROLE_EMPLOYEE, ROLE_MANAGER, ROLE_ADMIN)

# A manager is an employee who can approve their direct reports; an admin can
# approve anything. Approval authority is therefore role + the manager link on the
# employee record, never a client-side claim.
APPROVER_ROLES = (ROLE_MANAGER, ROLE_ADMIN)


def utcnow() -> datetime:
    """Naive-stored UTC. SQLite has no timezone column; everything here is UTC."""
    return datetime.now(timezone.utc).replace(tzinfo=None)


class User(Base):
    """An account. Employees are linked to a roster row; the admin is not."""

    __tablename__ = "users"

    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    employee_id: Mapped[str | None] = mapped_column(String(32), unique=True, index=True)
    username: Mapped[str] = mapped_column(String(64), unique=True, index=True, nullable=False)
    work_email: Mapped[str | None] = mapped_column(String(160), unique=True, index=True)
    display_name: Mapped[str] = mapped_column(String(160), nullable=False)
    role: Mapped[str] = mapped_column(String(16), nullable=False, default=ROLE_EMPLOYEE)
    manager_id: Mapped[str | None] = mapped_column(String(32), index=True)

    password_hash: Mapped[str] = mapped_column(String(128), nullable=False)
    # Set when an account is created with a temporary password. The API refuses
    # every non-login route while it is true, which is the only way a seeded
    # default credential stops being a default.
    must_change_password: Mapped[bool] = mapped_column(Boolean, default=False)

    failed_attempts: Mapped[int] = mapped_column(Integer, default=0)
    locked_until: Mapped[datetime | None] = mapped_column(DateTime)
    disabled: Mapped[bool] = mapped_column(Boolean, default=False)

    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    last_login_at: Mapped[datetime | None] = mapped_column(DateTime)

    def is_approver(self) -> bool:
        return self.role in APPROVER_ROLES


class StoreDoc(Base):
    """A whole client store, versioned."""

    __tablename__ = "store_docs"

    key: Mapped[str] = mapped_column(String(64), primary_key=True)
    value: Mapped[dict | list] = mapped_column(JSON, nullable=False)
    version: Mapped[int] = mapped_column(Integer, default=1, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, onupdate=utcnow)
    updated_by: Mapped[str | None] = mapped_column(String(32))


class PunchEvent(Base):
    """One check-in or check-out, as the server saw it."""

    __tablename__ = "punch_events"
    __table_args__ = (
        UniqueConstraint("punch_id", name="uq_punch_id"),
        Index("ix_punch_employee_date", "employee_id", "ist_date"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    # Client-generated UUID. Retries of the same punch resolve to the same row
    # instead of double-punching, which is what makes a local-first queue safe.
    punch_id: Mapped[str] = mapped_column(String(36), nullable=False)

    employee_id: Mapped[str] = mapped_column(String(32), nullable=False, index=True)
    kind: Mapped[str] = mapped_column(String(8), nullable=False)  # "in" | "out"

    client_captured_at: Mapped[datetime | None] = mapped_column(DateTime)
    server_received_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, nullable=False)
    # The attendance day, resolved server-side in IST. A punch at 11:58 pm IST is
    # the same day here as it is on the phone, regardless of the server's own zone.
    ist_date: Mapped[str] = mapped_column(String(10), nullable=False, index=True)

    latitude: Mapped[float | None] = mapped_column(Float)
    longitude: Mapped[float | None] = mapped_column(Float)
    accuracy_m: Mapped[int | None] = mapped_column(Integer)
    distance_m: Mapped[int | None] = mapped_column(Integer)
    inside_geofence: Mapped[bool | None] = mapped_column(Boolean)
    # Why the server accepted or flagged the punch (outside geofence, coarse fix,
    # punched out without an open check-in, and so on). Advisory, not a rejection:
    # dropping a real punch because of a bad GPS fix is worse than recording it.
    notes: Mapped[str | None] = mapped_column(Text)

    actor_user_id: Mapped[str | None] = mapped_column(String(32), ForeignKey("users.id"))


class AuditEntry(Base):
    """Append-only trail of authoritative changes."""

    __tablename__ = "audit_entries"
    __table_args__ = (Index("ix_audit_actor_time", "actor_user_id", "at"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    actor_user_id: Mapped[str | None] = mapped_column(String(32), ForeignKey("users.id"))
    actor_label: Mapped[str] = mapped_column(String(160), default="anonymous")
    action: Mapped[str] = mapped_column(String(64), nullable=False)
    target: Mapped[str | None] = mapped_column(String(160))
    detail: Mapped[dict | None] = mapped_column(JSON)
    at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, nullable=False)
