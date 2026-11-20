"""Auto-trigger from Stage A alerts: bounded, idempotent, kind-filtered.
Unit tests use a fake conn; the Postgres test runs the real SQL inside a
rolled-back transaction against temp tables (skipped without a DB)."""
import json
import os

import pytest

from triggers import ENQUEUE_SQL, auto_enabled, enqueue_from_alerts


class Res:
    def __init__(self, rows):
        self.rows = rows

    def fetchone(self):
        return self.rows[0]

    def fetchall(self):
        return self.rows


class TriggerConn:
    def __init__(self, recent=0, new_ids=(11, 12)):
        self.recent = recent
        self.new_ids = list(new_ids)
        self.calls = []
        self.commits = 0

    def execute(self, sql, params=None):
        self.calls.append((sql, params))
        if "COUNT(*)" in sql:
            return Res([(self.recent,)])
        return Res([(i,) for i in self.new_ids[: params[1]]])

    def commit(self):
        self.commits += 1


def test_enqueue_respects_batch_and_kinds(monkeypatch):
    monkeypatch.delenv("INVESTIGATOR_AUTO_KINDS", raising=False)
    c = TriggerConn()
    assert enqueue_from_alerts(c, batch=1, max_per_hour=20) == [11]
    sql, params = c.calls[-1]
    assert sql == ENQUEUE_SQL
    assert "whale_transfer" in params[0] and "reorg_invalidation" not in params[0]
    assert params[1] == 1


def test_hourly_cap_blocks_enqueue():
    c = TriggerConn(recent=20)
    assert enqueue_from_alerts(c, batch=10, max_per_hour=20) == []
    assert len(c.calls) == 1  # only the cap count query ran


def test_kinds_env_and_disable(monkeypatch):
    monkeypatch.setenv("INVESTIGATOR_AUTO_KINDS", "whale_transfer")
    c = TriggerConn()
    enqueue_from_alerts(c, batch=5, max_per_hour=20)
    assert c.calls[-1][1][0] == ["whale_transfer"]
    monkeypatch.setenv("INVESTIGATOR_AUTO_TRIGGER", "false")
    assert not auto_enabled()
    monkeypatch.delenv("INVESTIGATOR_AUTO_TRIGGER")
    assert auto_enabled()


PG = os.getenv("NEXUS_TEST_DATABASE_URL")


@pytest.mark.skipif(not PG, reason="NEXUS_TEST_DATABASE_URL unset")
def test_enqueue_sql_against_postgres():
    import psycopg
    conn = psycopg.connect(PG)
    try:
        conn.execute("CREATE TEMP TABLE alerts (id BIGSERIAL PRIMARY KEY, source_engine TEXT, "
                     "kind TEXT, chain_id INTEGER, record JSONB)")
        conn.execute("CREATE TEMP TABLE investigations (id BIGSERIAL PRIMARY KEY, trigger TEXT, "
                     "evidence JSONB, status TEXT, chain_id INTEGER, trigger_tx TEXT, "
                     "source_alert_id BIGINT, created_at TIMESTAMPTZ DEFAULT now())")
        conn.execute("CREATE UNIQUE INDEX ON investigations (chain_id, trigger_tx) "
                     "WHERE source_alert_id IS NOT NULL")
        rows = [
            ("wallet_intelligence", "whale_transfer", 1, {"facts": {"tx_hash": "0xAA", "block_number": 5}}),
            ("wallet_intelligence", "whale_transfer", 1, {"facts": {"tx_hash": "0xaa", "block_number": 5}}),
            ("mev_analyzer", "potential_sandwich", 1, {"facts": {"evidence": [{"tx_hash": "0xbb"}]}}),
            ("wallet_intelligence", "reorg_invalidation", 1, {"facts": {"tx_hash": "0xcc"}}),
            ("dex_monitor", "liquidity_removal", 8453, {"facts": {"tx_hash": None}}),
        ]
        for r in rows:
            conn.execute("INSERT INTO alerts (source_engine, kind, chain_id, record) VALUES (%s,%s,%s,%s)",
                         (r[0], r[1], r[2], json.dumps(r[3])))
        conn.execute("INSERT INTO investigations (trigger, chain_id, trigger_tx, status) "
                     "VALUES ('manual', 1, '0xdd', 'complete')")
        conn.execute("INSERT INTO alerts (source_engine, kind, chain_id, record) VALUES "
                     "('wallet_intelligence','whale_transfer',1,'{\"facts\":{\"tx_hash\":\"0xdd\"}}')")
        conn.commit = lambda: None  # keep everything inside the test transaction
        ids = enqueue_from_alerts(conn, batch=10, max_per_hour=20)
        got = conn.execute("SELECT trigger_tx, status, source_alert_id FROM investigations "
                           "WHERE source_alert_id IS NOT NULL ORDER BY trigger_tx").fetchall()
        assert len(ids) == 2
        assert [(g[0], g[1]) for g in got] == [("0xaa", "queued"), ("0xbb", "queued")]
        assert got[0][2] == 1  # lowest alert id for the duplicated tx
        assert enqueue_from_alerts(conn, batch=10, max_per_hour=20) == []  # idempotent
    finally:
        conn.rollback()
        conn.close()
