import os
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


class FakeCur:
    def __init__(self, rows=None):
        self.rows = rows or []
    def fetchall(self):
        return self.rows
    def fetchone(self):
        return self.rows[0] if self.rows else None


class FakeConn:
    def __init__(self):
        self.queries = []
        self.watchlists = []
        self._next_id = 1
        self.wallet_scores = {}
        self.alerts = []
        self.deliveries = {}
        self.checkpoints = []
        self.committed = False

    def execute(self, sql, params=None):
        self.queries.append((sql, params))
        s = sql.upper()
        if "FROM CHECKPOINTS" in s:
            return FakeCur(self.checkpoints)
        if "INSERT INTO WATCHLISTS" in s:
            self.watchlists.append((self._next_id, *params)); self._next_id += 1
            return FakeCur()
        if "DELETE FROM WATCHLISTS" in s:
            before = len(self.watchlists)
            self.watchlists = [w for w in self.watchlists if w[0] != params[0]]
            return FakeCur([(params[0],)] if len(self.watchlists) < before else [])
        if "FROM WATCHLISTS" in s:
            return FakeCur(self.watchlists)
        if "FROM WALLET_SCORES" in s:
            w = self.wallet_scores.get(params[0])
            return FakeCur([w] if w else [])
        if "FROM ALERT_DELIVERIES" in s:
            return FakeCur(self.deliveries.get(params[0], []))
        if "FROM ALERTS WHERE ID" in s:
            return FakeCur([a for a in self.alerts if a[0] == params[0]])
        if "FROM ALERTS" in s:
            return FakeCur(self.alerts[: params[0]])
        if "FROM LOGS" in s:
            return FakeCur([])
        return FakeCur()

    def commit(self):
        self.committed = True

    def close(self):
        pass


@pytest.fixture
def conn():
    return FakeConn()


@pytest.fixture
def client(conn, monkeypatch):
    import main
    monkeypatch.setenv("NEXUS_API_KEY", "test-key")
    main.set_conn(conn)
    c = TestClient(main.app)
    yield c
    main.set_conn(None)


AUTH = {"X-Api-Key": "test-key"}
