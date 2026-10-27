"""Database engine and session plumbing.

SQLite needs two pragmas to behave sensibly with a web server: WAL, so a reader
never blocks a writer, and a busy timeout, so two simultaneous punches queue
instead of throwing "database is locked" at the user.
"""

from contextlib import contextmanager

from sqlalchemy import create_engine, event
from sqlalchemy.orm import declarative_base, sessionmaker

from . import config

# check_same_thread=False: uvicorn hands requests to worker threads. SQLite is
# fine with that under WAL as long as each request gets its own session, which
# the scoped_session below does.
engine = create_engine(
    config.DATABASE_URL,
    connect_args={"check_same_thread": False, "timeout": 20},
    future=True,
)

SessionLocal = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False, future=True)
Base = declarative_base()


@event.listens_for(engine, "connect")
def _set_sqlite_pragmas(dbapi_connection, _record):
    cursor = dbapi_connection.cursor()
    cursor.execute("PRAGMA journal_mode=WAL")
    cursor.execute("PRAGMA foreign_keys=ON")
    cursor.execute("PRAGMA synchronous=NORMAL")
    cursor.close()


@contextmanager
def session_scope():
    """Transactional scope; commits on success, rolls back on any escape."""
    session = SessionLocal()
    try:
        yield session
        session.commit()
    except Exception:
        session.rollback()
        raise
    finally:
        session.close()


def get_db():
    """FastAPI dependency yielding one session per request."""
    session = SessionLocal()
    try:
        yield session
    finally:
        session.close()


def init_db() -> None:
    """Create the data directory and any missing tables."""
    config.ensure_data_dir()
    # Imported here so the module-level Base has the tables registered by the
    # time create_all runs, without a circular import at module load.
    from . import models  # noqa: F401

    Base.metadata.create_all(bind=engine)
