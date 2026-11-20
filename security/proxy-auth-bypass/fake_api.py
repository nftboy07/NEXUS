"""Launch the REAL NEXUS API (apps/api/main.py) with an in-memory store so
the PoC needs no Postgres. Only the DB connection is faked; auth
(require_key) and every route are the untouched production code.

A single watchlist row (id=1) is pre-seeded so the PoC can show an
unauthenticated attacker deleting it through the dashboard proxy.
Run: python fake_api.py  (serves 127.0.0.1:8000, NEXUS_API_KEY from env)
"""
from __future__ import annotations
import os, sys
from pathlib import Path

API_DIR = Path(__file__).resolve().parents[2] / "apps" / "api"
sys.path.insert(0, str(API_DIR))

import main  # the real API module


class FakeCur:
    def __init__(self, rows=None): self.rows = rows or []
    def fetchall(self): return self.rows
    def fetchone(self): return self.rows[0] if self.rows else None


class FakeConn:
    """Minimal stand-in for psycopg conn: supports the watchlist +
    checkpoints queries the PoC touches."""
    def __init__(self):
        self.watchlists = [(1, "wallet", "0xvictim", "monitored target")]
    def execute(self, sql, params=None):
        s = sql.upper()
        if "FROM CHECKPOINTS" in s:
            return FakeCur([])
        if "DELETE FROM WATCHLISTS" in s:
            before = len(self.watchlists)
            self.watchlists = [w for w in self.watchlists if w[0] != params[0]]
            return FakeCur([(params[0],)] if len(self.watchlists) < before else [])
        if "FROM WATCHLISTS" in s:
            return FakeCur(self.watchlists)
        return FakeCur()
    def commit(self): pass
    def close(self): pass


if __name__ == "__main__":
    if not os.getenv("NEXUS_API_KEY"):
        print("set NEXUS_API_KEY", file=sys.stderr); sys.exit(2)
    main.set_conn(FakeConn())
    import uvicorn
    uvicorn.run(main.app, host="127.0.0.1", port=int(os.getenv("POC_API_PORT", "8000")), log_level="warning")
