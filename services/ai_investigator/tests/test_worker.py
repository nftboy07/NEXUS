"""Worker mode: atomic claiming (SKIP LOCKED emulation), no-model
awaiting_model path with zero HTTP calls, requeue semantics."""
import json
import threading

import httpx
import pytest

from worker import claim_next, requeue, tick


class SpyTransport(httpx.BaseTransport):
    def __init__(self):
        self.calls = 0

    def handle_request(self, request):
        self.calls += 1
        return httpx.Response(200, json={
            "choices": [{"message": {"content": "{}"}}],
            "usage": {"prompt_tokens": 1, "completion_tokens": 1}})


class WorkerConn:
    """Emulates FOR UPDATE SKIP LOCKED: claims are serialized through a
    lock and 'queued' rows flip to 'running' atomically, so two workers
    can never claim the same row."""

    _lock = threading.Lock()

    def __init__(self, rows, base_conn):
        # rows: dict id -> {"status": str, "chain_id": int, "trigger_tx": str, "updated_stale": bool}
        self.rows = rows
        self.base = base_conn  # delegates evidence queries to the shared fixture conn

    def execute(self, sql, params=None):
        s = " ".join(sql.upper().split())
        if "FOR UPDATE SKIP LOCKED" in s:
            with WorkerConn._lock:
                claimable = sorted(i for i, r in self.rows.items() if r["status"] == "queued")
                if not claimable:
                    return FakeResult(None)
                i = claimable[0]
                self.rows[i]["status"] = "running"
                r = self.rows[i]
                return FakeResult((i, r["chain_id"], r["trigger_tx"]))
        if "SET EVIDENCE" in s:
            self.rows[params[1]]["status"] = "package_built"
            return FakeResult(None)
        if "UPDATE INVESTIGATIONS SET STATUS" in s and "WHERE ID" in s:
            self.rows[params[-1]]["status"] = params[0]
            return FakeResult(None)
        if "STATUS='QUEUED'" in s and "AWAITING_MODEL" in s:
            n = sum(1 for r in self.rows.values() if r["status"] == "awaiting_model")
            for r in self.rows.values():
                if r["status"] == "awaiting_model":
                    r["status"] = "queued"
            return FakeResult(None, rowcount=n)
        if "STATUS='QUEUED'" in s and "'RUNNING'" in s:
            n = sum(1 for r in self.rows.values()
                    if r["status"] == "running" and r.get("stale"))
            for r in self.rows.values():
                if r["status"] == "running" and r.get("stale"):
                    r["status"] = "queued"
            return FakeResult(None, rowcount=n)
        return self.base.execute(sql, params)

    def commit(self):
        pass

    def rollback(self):
        pass


class FakeResult:
    def __init__(self, row, rowcount=1):
        self._row = row
        self.rowcount = rowcount

    def fetchone(self):
        return self._row


def test_two_workers_cannot_claim_same_row(conn):
    rows = {1: {"status": "queued", "chain_id": 1, "trigger_tx": "0xtx1"},
            2: {"status": "queued", "chain_id": 1, "trigger_tx": "0xtx1"}}
    a, b = WorkerConn(rows, conn), WorkerConn(rows, conn)
    claims = []
    ts = [threading.Thread(target=lambda: claims.append(claim_next(a))),
          threading.Thread(target=lambda: claims.append(claim_next(b)))]
    for t in ts: t.start()
    for t in ts: t.join()
    claimed_ids = {c[0] for c in claims if c}
    assert len(claimed_ids) == len([c for c in claims if c]) == 2  # distinct rows
    assert claim_next(a) is None  # queue drained


def test_no_model_awaiting_model_no_http(conn, monkeypatch):
    rows = {1: {"status": "queued", "chain_id": 1, "trigger_tx": "0xtx1"}}
    wc = WorkerConn(rows, conn)
    spy = SpyTransport()
    monkeypatch.delenv("LLM_API_KEY", raising=False)
    # patch the updates finish_investigation issues to the fake row store
    import investigate
    assert tick(wc, __import__("logging").getLogger("t"), transport=spy)
    assert spy.calls == 0
    assert rows[1]["status"] == "awaiting_model"


def test_requeue_stale_and_awaiting(conn, monkeypatch):
    rows = {1: {"status": "running", "chain_id": 1, "trigger_tx": "0x", "stale": True},
            2: {"status": "awaiting_model", "chain_id": 1, "trigger_tx": "0x"},
            3: {"status": "running", "chain_id": 1, "trigger_tx": "0x", "stale": False}}
    wc = WorkerConn(rows, conn)
    out = requeue(wc, model_configured=True)
    assert out == {"stale_running": 1, "awaiting_model": 1}
    assert rows[1]["status"] == "queued" and rows[2]["status"] == "queued"
    assert rows[3]["status"] == "running"
    out2 = requeue(wc, model_configured=False)
    rows[4] = {"status": "awaiting_model", "chain_id": 1, "trigger_tx": "0x"}
    requeue(wc, model_configured=False)
    assert rows[4]["status"] == "awaiting_model"  # not requeued without a model
