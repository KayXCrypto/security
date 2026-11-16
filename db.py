"""
db.py
─────
Database connection for the services (`from db import get_db`).

    conn = get_db()
    try:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute(...)
        conn.commit()
    finally:
        conn.close()

Configuration comes from environment variables:

    DATABASE_URL   postgresql://user:pass@host:5432/dbname      (takes priority)
or
    DB_HOST (localhost)  DB_PORT (5432)  DB_NAME  DB_USER  DB_PASSWORD

    DB_POOL_MAX    0 (default) = open a new connection per call.
                   N > 0       = keep up to N connections and reuse them;
                                 conn.close() then hands the connection back to
                                 the pool instead of closing it.
    DB_CONNECT_TIMEOUT  seconds to wait for the server (default 5)
"""
import os
import threading

import psycopg2
from psycopg2 import pool as _pg_pool

_POOL = None
_POOL_LOCK = threading.Lock()


def _dsn():
    url = os.environ.get("DATABASE_URL")
    if url:
        return {"dsn": url}
    return {
        "host": os.environ.get("DB_HOST", "10.69.22.130"),
        "port": int(os.environ.get("DB_PORT", "5432")),
        "dbname": os.environ.get("DB_NAME", "network_monitor"),
        "user": os.environ.get("DB_USER", "otkanban"),
        "password": os.environ.get("DB_PASSWORD", "WVN@OTKANBAN"),
    }


def _connect():
    kw = _dsn()
    kw["connect_timeout"] = int(os.environ.get("DB_CONNECT_TIMEOUT", "5"))
    conn = psycopg2.connect(**kw)
    # Every service commits explicitly; keep the default transactional mode.
    conn.autocommit = False
    return conn


class _PooledConnection:
    """Wraps a pooled connection so existing code that calls conn.close()
    returns it to the pool instead of dropping it."""

    def __init__(self, pool, conn):
        self._pool = pool
        self._conn = conn
        self._released = False

    def __getattr__(self, name):          # cursor(), commit(), rollback(), ...
        return getattr(self._conn, name)

    def close(self):
        if self._released:
            return
        self._released = True
        try:
            # Anything not committed is thrown away, as with a plain close().
            if not self._conn.closed:
                self._conn.rollback()
        finally:
            self._pool.putconn(self._conn, close=bool(self._conn.closed))

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        self.close()


def _get_pool(size):
    global _POOL
    if _POOL is None:
        with _POOL_LOCK:
            if _POOL is None:
                kw = _dsn()
                kw["connect_timeout"] = int(os.environ.get("DB_CONNECT_TIMEOUT", "5"))
                _POOL = _pg_pool.ThreadedConnectionPool(1, size, **kw)
    return _POOL


def get_db():
    """A new psycopg2 connection (or a pooled one when DB_POOL_MAX > 0).
    The caller commits and closes it."""
    size = int(os.environ.get("DB_POOL_MAX", "0"))
    if size > 0:
        pool = _get_pool(size)
        return _PooledConnection(pool, pool.getconn())
    return _connect()