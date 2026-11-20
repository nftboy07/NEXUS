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
        self.pending = []
        self.pools = []
        self.reserves = {}
        self.mev_findings = []
        self.investigations = []
        self.blocks_max = {}
        self.provider_health = []
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
        if "INSERT INTO INVESTIGATIONS" in s:
            self.investigations.append((len(self.investigations) + 1, *params) + (None,) * 7)
            return FakeCur()
        if "FROM INVESTIGATIONS WHERE ID" in s:
            return FakeCur([i for i in self.investigations if i[0] == params[0]])
        if "FROM INVESTIGATIONS" in s:
            return FakeCur(self.investigations[: params[0]])
        if "FROM PENDING_TRANSACTIONS" in s:
            rows = self.pending
            if params and len(params) > 1:
                rows = [r for r in rows if r[8] == params[0]]
            return FakeCur(rows[: params[-1]])
        if "FROM POOLS WHERE ID" in s:
            return FakeCur([pl for pl in self.pools if pl[0] == params[0]])
        if "FROM POOLS" in s:
            return FakeCur(self.pools[: params[-1]])
        if "FROM POOL_RESERVES" in s:
            return FakeCur(self.reserves.get(params[0], []))
        if "FROM MEV_FINDINGS" in s:
            return FakeCur(self.mev_findings[: params[-1]])
        if "MAX(NUMBER) FROM BLOCKS" in s:
            return FakeCur([(self.blocks_max.get(params[0]),)])
        if "FROM PROVIDER_HEALTH" in s:
            return FakeCur(self.provider_health)
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
