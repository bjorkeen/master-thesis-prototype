"""
db.py — Shared database connection module for HITL-CDT services.

This module provides a single SQLAlchemy engine and session factory that
any service can import. It tries PostgreSQL first; if that fails it falls
back to a local SQLite file (data/hitl_cdt.db).

Usage in a service:
    from data.db import get_session, engine

    with get_session() as session:
        session.add(some_model_instance)
        session.commit()
"""

import os
import logging
from contextlib import contextmanager
from pathlib import Path

from sqlalchemy import create_engine, text
from sqlalchemy.orm import sessionmaker, declarative_base

# --------------------------------------------------------------------------- #
# Logging
# --------------------------------------------------------------------------- #
logging.basicConfig(level=logging.INFO)
log = logging.getLogger(__name__)

# --------------------------------------------------------------------------- #
# SQLAlchemy Base — all ORM models inherit from this
# --------------------------------------------------------------------------- #
Base = declarative_base()

# --------------------------------------------------------------------------- #
# Database URL resolution
# --------------------------------------------------------------------------- #
# You can override the URL with the DATABASE_URL environment variable.
# Otherwise the module tries PostgreSQL and falls back to SQLite.

_POSTGRES_URL = os.getenv(
    "DATABASE_URL",
    "postgresql://postgres:postgres@localhost:5432/hitl_cdt",
)

# SQLite path: lives next to this file in the data/ directory
_SQLITE_PATH = Path(__file__).parent / "hitl_cdt.db"
_SQLITE_URL = f"sqlite:///{_SQLITE_PATH}"


def _try_postgres(url: str):
    """
    Attempt to create and test a PostgreSQL engine.
    Returns the engine if successful, None otherwise.
    """
    try:
        import psycopg2  # noqa: F401 — just checking the driver is installed
        engine = create_engine(
            url,
            pool_pre_ping=True,   # check connection liveness before using it
            pool_size=5,
            max_overflow=10,
            echo=False,           # set True to log every SQL statement (noisy)
        )
        # Actually try a query so we fail fast if the server is unreachable
        with engine.connect() as conn:
            conn.execute(text("SELECT 1"))
        return engine
    except Exception as exc:
        log.warning("PostgreSQL unavailable (%s). Falling back to SQLite.", exc)
        return None


def _make_sqlite(path: str):
    """Create a SQLite engine. Always succeeds."""
    engine = create_engine(
        path,
        connect_args={"check_same_thread": False},  # needed for FastAPI threads
        echo=False,
    )
    log.info("Using SQLite database at %s", _SQLITE_PATH)
    return engine


# --------------------------------------------------------------------------- #
# Module-level engine — resolved once at import time
# --------------------------------------------------------------------------- #
def _resolve_engine():
    # Respect an explicit DATABASE_URL that points to SQLite
    if _POSTGRES_URL.startswith("sqlite"):
        return _make_sqlite(_POSTGRES_URL)

    engine = _try_postgres(_POSTGRES_URL)
    if engine is not None:
        log.info("Connected to PostgreSQL at %s", _POSTGRES_URL)
        return engine

    return _make_sqlite(_SQLITE_URL)


engine = _resolve_engine()

# --------------------------------------------------------------------------- #
# Session factory
# --------------------------------------------------------------------------- #
SessionLocal = sessionmaker(
    bind=engine,
    autocommit=False,   # we commit explicitly
    autoflush=False,    # we flush explicitly (avoids surprise queries)
    expire_on_commit=False,  # keep objects usable after commit
)


@contextmanager
def get_session():
    """
    Context manager that yields a database session and handles commit/rollback.

    Example:
        with get_session() as session:
            session.add(record)
            # commit happens automatically on exit

    If an exception is raised inside the block the transaction is rolled back
    and the exception propagates normally.
    """
    session = SessionLocal()
    try:
        yield session
        session.commit()
    except Exception:
        session.rollback()
        raise
    finally:
        session.close()


# --------------------------------------------------------------------------- #
# FastAPI dependency helper (optional convenience)
# --------------------------------------------------------------------------- #
def get_db():
    """
    FastAPI dependency that yields a database session per request.

    Usage in a FastAPI route:
        from data.db import get_db
        from sqlalchemy.orm import Session
        from fastapi import Depends

        @app.get("/items")
        def read_items(db: Session = Depends(get_db)):
            return db.query(MyModel).all()
    """
    session = SessionLocal()
    try:
        yield session
        session.commit()
    except Exception:
        session.rollback()
        raise
    finally:
        session.close()


# --------------------------------------------------------------------------- #
# Convenience: which backend are we actually using?
# --------------------------------------------------------------------------- #
def db_backend() -> str:
    """Return 'postgresql' or 'sqlite' — useful for health-check endpoints."""
    return engine.dialect.name
