"""NEXUS API — read-only monitoring API (Engine 7, Crypto Relic).

Auth: NEXUS_API_KEY via X-Api-Key header, compared with a hashed
constant-time check; the key is never logged or returned. Watchlist
operations are the only mutations — alert/dispatch rules stay in
service config (BLUEPRINT §9)."""
from __future__ import annotations

import hashlib
import hmac
import json
import os
from pathlib import Path
from typing import Any, Optional

import psycopg
from fastapi import Depends, FastAPI, Header, HTTPException
from pydantic import BaseModel

CHAINS_PATH = Path(__file__).resolve().parents[2] / "packages" / "chain_config" / "chains.json"

app = FastAPI(title="NEXUS", description="Autonomous Blockchain Intelligence Network — Crypto Relic")

_db_conn = None


def set_conn(conn) -> None:
    """Inject a connection (tests) — production uses DATABASE_URL."""
    global _db_conn
    _db_conn = conn


def get_conn():
    global _db_conn
    if _db_conn is not None:
        return _db_conn
    url = os.getenv("DATABASE_URL")
    if not url:
        raise HTTPException(503, "DATABASE_URL not configured")
    _db_conn = psycopg.connect(url)
    return _db_conn


def require_key(x_api_key: Optional[str] = Header(default=None)) -> None:
    expected = os.getenv("NEXUS_API_KEY")
    if not expected:
        raise HTTPException(503, "NEXUS_API_KEY not configured")
    if x_api_key is None:
        raise HTTPException(401, "missing api key")
    if not hmac.compare_digest(
            hashlib.sha256(x_api_key.encode()).digest(),
            hashlib.sha256(expected.encode()).digest()):
        raise HTTPException(401, "invalid api key")


@app.get("/health")
def health():
    conn = get_conn()
    rows = conn.execute("SELECT chain_id, last_block FROM checkpoints ORDER BY chain_id").fetchall()
    return {"status": "ok", "service": "nexus-api",
            "checkpoints": [{"chain_id": r[0], "last_block": r[1]} for r in rows]}


@app.get("/chains")
def chains():
    cfg = json.loads(CHAINS_PATH.read_text())
    if isinstance(cfg, dict):
        cfg = cfg.get("chains", [])
    out = []
    for c in cfg:
        out.append({"id": c.get("id"), "name": c.get("name"),
                    "enabled": c.get("enabled", True)})
    return out


def _alert_dict(r, deliveries=None):
    return {"id": r[0], "dedup_key": r[1], "source_engine": r[2], "kind": r[3],
            "chain_id": r[4], "record": r[5], "destination": r[6],
            "delivery_state": r[7], "created_at": str(r[8]),
            "deliveries": deliveries or []}


ALERT_COLS = ("id, dedup_key, source_engine, kind, chain_id, record, "
              "destination, delivery_state, created_at")


def _deliveries(conn, alert_id: int):
    rows = conn.execute(
        "SELECT channel, state, attempts, last_error, updated_at "
        "FROM alert_deliveries WHERE alert_id=%s", (alert_id,)).fetchall()
    return [{"channel": r[0], "state": r[1], "attempts": r[2],
             "last_error": r[3], "updated_at": str(r[4])} for r in rows]


@app.get("/alerts", dependencies=[Depends(require_key)])
def alerts(limit: int = 50):
    conn = get_conn()
    rows = conn.execute(
        f"SELECT {ALERT_COLS} FROM alerts ORDER BY id DESC LIMIT %s",
        (limit,)).fetchall()
    return [_alert_dict(r, _deliveries(conn, r[0])) for r in rows]


@app.get("/alerts/{alert_id}", dependencies=[Depends(require_key)])
def alert(alert_id: int):
    conn = get_conn()
    r = conn.execute(
        f"SELECT {ALERT_COLS} FROM alerts WHERE id=%s", (alert_id,)).fetchone()
    if not r:
        raise HTTPException(404, "alert not found")
    return _alert_dict(r, _deliveries(conn, alert_id))


class WatchlistIn(BaseModel):
    kind: str  # e.g. "wallet", "token", "pool"
    value: str  # address or identifier
    note: Optional[str] = None


@app.post("/watchlists", dependencies=[Depends(require_key)], status_code=201)
def create_watchlist(body: WatchlistIn):
    conn = get_conn()
    conn.execute(
        "INSERT INTO watchlists(kind,value,note) VALUES (%s,%s,%s)",
        (body.kind, body.value.lower(), body.note))
    conn.commit()
    return {"created": True, "kind": body.kind, "value": body.value.lower()}


@app.get("/watchlists", dependencies=[Depends(require_key)])
def list_watchlists():
    conn = get_conn()
    rows = conn.execute(
        "SELECT id, kind, value, note FROM watchlists ORDER BY id").fetchall()
    return [{"id": r[0], "kind": r[1], "value": r[2], "note": r[3]} for r in rows]


@app.delete("/watchlists/{watchlist_id}", dependencies=[Depends(require_key)])
def delete_watchlist(watchlist_id: int):
    conn = get_conn()
    cur = conn.execute("DELETE FROM watchlists WHERE id=%s RETURNING id", (watchlist_id,))
    conn.commit()
    if cur.fetchone() is None:
        raise HTTPException(404, "watchlist entry not found")
    return {"deleted": watchlist_id}


@app.get("/wallets/{address}", dependencies=[Depends(require_key)])
def wallet(address: str):
    conn = get_conn()
    r = conn.execute(
        "SELECT score, coverage, components FROM wallet_scores WHERE wallet=%s",
        (address.lower(),)).fetchone()
    if not r:
        raise HTTPException(404, "wallet not tracked")
    return {"address": address.lower(), "score": r[0],
            "coverage": r[1], "components": r[2]}


@app.get("/events", dependencies=[Depends(require_key)])
def events(chain_id: int, limit: int = 50):
    conn = get_conn()
    rows = conn.execute(
        "SELECT tx_hash, block_number, address FROM logs WHERE chain_id=%s "
        "AND removed=FALSE ORDER BY block_number DESC LIMIT %s",
        (chain_id, limit)).fetchall()
    return [{"tx_hash": r[0], "block_number": r[1], "address": r[2]} for r in rows]


# ---------- dashboard-facing endpoints (Engine 7 PR-B data) ----------


@app.get("/pending", dependencies=[Depends(require_key)])
def pending(status: Optional[str] = None, chain_id: Optional[int] = None, limit: int = 50):
    """Engine 2 pending lifecycle rows. These are unconfirmed mempool
    observations — never presented as confirmed transactions."""
    conn = get_conn()
    sql = ("SELECT chain_id, hash, sender, nonce, recipient, value, method, "
           "decoded, status, first_seen_block, included_block, replaced_by "
           "FROM pending_transactions")
    cond, params = [], []
    if status:
        cond.append("status = %s"); params.append(status)
    if chain_id is not None:
        cond.append("chain_id = %s"); params.append(chain_id)
    if cond:
        sql += " WHERE " + " AND ".join(cond)
    sql += " ORDER BY updated_at DESC LIMIT %s"
    params.append(limit)
    rows = conn.execute(sql, params).fetchall()
    return [{"chain_id": r[0], "hash": r[1], "sender": r[2], "nonce": r[3],
             "recipient": r[4], "value": str(r[5]) if r[5] is not None else None,
             "method": r[6], "decoded": r[7], "status": r[8],
             "first_seen_block": r[9], "included_block": r[10],
             "replaced_by": r[11]} for r in rows]


@app.get("/pools", dependencies=[Depends(require_key)])
def pools(chain_id: Optional[int] = None, limit: int = 50):
    conn = get_conn()
    sql = ("SELECT id, dex, token0, token1, chain_id, fee_tier, created_block, "
           "discovery FROM pools")
    params: list = []
    if chain_id is not None:
        sql += " WHERE chain_id = %s"; params.append(chain_id)
    sql += " ORDER BY id LIMIT %s"; params.append(limit)
    rows = conn.execute(sql, params).fetchall()
    return [{"id": r[0], "dex": r[1], "token0": r[2], "token1": r[3],
             "chain_id": r[4], "fee_tier": r[5], "created_block": r[6],
             "discovery": r[7]} for r in rows]


@app.get("/pools/{pool_id}", dependencies=[Depends(require_key)])
def pool(pool_id: str):
    conn = get_conn()
    r = conn.execute(
        "SELECT id, dex, token0, token1, chain_id, fee_tier, created_block, "
        "discovery FROM pools WHERE id = %s", (pool_id,)).fetchone()
    if not r:
        raise HTTPException(404, "pool not found")
    res = conn.execute(
        "SELECT reserve0, reserve1, source, block_number FROM pool_reserves "
        "WHERE pool_id = %s ORDER BY block_number DESC LIMIT 1",
        (pool_id,)).fetchone()
    return {"id": r[0], "dex": r[1], "token0": r[2], "token1": r[3],
            "chain_id": r[4], "fee_tier": r[5], "created_block": r[6],
            "discovery": r[7],
            "latest_reserves": (
                {"reserve0": str(res[0]), "reserve1": str(res[1]),
                 "source": res[2], "block_number": res[3]} if res else None)}


@app.get("/mev", dependencies=[Depends(require_key)])
def mev(kind: Optional[str] = None, chain_id: Optional[int] = None, limit: int = 50):
    conn = get_conn()
    sql = ("SELECT id, chain_id, block_number, kind, initiator, victim, pool_id, "
           "evidence, estimated_impact, confidence FROM mev_findings")
    cond, params = [], []
    if kind:
        cond.append("kind = %s"); params.append(kind)
    if chain_id is not None:
        cond.append("chain_id = %s"); params.append(chain_id)
    if cond:
        sql += " WHERE " + " AND ".join(cond)
    sql += " ORDER BY block_number DESC LIMIT %s"
    params.append(limit)
    rows = conn.execute(sql, params).fetchall()
    return [{"id": r[0], "chain_id": r[1], "block_number": r[2], "kind": r[3],
             "initiator": r[4], "victim": r[5], "pool_id": r[6],
             "evidence": r[7], "estimated_impact": r[8], "confidence": r[9]}
            for r in rows]


INVESTIGATION_COLS = ("id, trigger, chain_id, trigger_tx, status, report, "
                      "citations_valid, confidence, model, cost_estimate, created_at")


def _investigation_dict(r):
    return {"id": r[0], "trigger": r[1], "chain_id": r[2], "trigger_tx": r[3],
            "status": r[4], "report": r[5], "citations_valid": r[6],
            "confidence": r[7], "model": r[8],
            "cost_estimate": str(r[9]) if r[9] is not None else None,
            "created_at": str(r[10])}


@app.get("/investigations", dependencies=[Depends(require_key)])
def investigations(limit: int = 50):
    conn = get_conn()
    rows = conn.execute(
        f"SELECT {INVESTIGATION_COLS} FROM investigations ORDER BY id DESC LIMIT %s",
        (limit,)).fetchall()
    return [_investigation_dict(r) for r in rows]


@app.get("/investigations/{inv_id}", dependencies=[Depends(require_key)])
def investigation(inv_id: int):
    conn = get_conn()
    r = conn.execute(
        f"SELECT {INVESTIGATION_COLS} FROM investigations WHERE id=%s",
        (inv_id,)).fetchone()
    if not r:
        raise HTTPException(404, "investigation not found")
    return _investigation_dict(r)


class InvestigationIn(BaseModel):
    chain_id: int
    tx_hash: Optional[str] = None
    address: Optional[str] = None


@app.post("/investigations", dependencies=[Depends(require_key)], status_code=201)
def create_investigation(body: InvestigationIn):
    """Queue an investigation for Engine 6's CLI/worker. When no LLM is
    configured the row lands as 'awaiting_model' (package-only mode) —
    a report is never fabricated here."""
    if not body.tx_hash and not body.address:
        raise HTTPException(422, "tx_hash or address required")
    conn = get_conn()
    llm_ready = bool(os.getenv("LLM_API_KEY") and os.getenv("LLM_MODEL"))
    status = "queued" if llm_ready else "awaiting_model"
    trigger = f"chain:{body.chain_id}:tx:{body.tx_hash}" if body.tx_hash \
        else f"chain:{body.chain_id}:address:{body.address.lower()}"
    conn.execute(
        "INSERT INTO investigations (trigger, chain_id, trigger_tx, status) "
        "VALUES (%s,%s,%s,%s)",
        (trigger, body.chain_id, body.tx_hash, status))
    conn.commit()
    return {"created": True, "status": status, "trigger": trigger}


_redis_client = None


def set_redis(client) -> None:
    """Inject a redis client (tests)."""
    global _redis_client
    _redis_client = client


def get_redis():
    global _redis_client
    if _redis_client is not None:
        return _redis_client
    url = os.getenv("REDIS_URL")
    if not url:
        return None
    import redis as redis_lib
    _redis_client = redis_lib.from_url(url)
    return _redis_client


@app.get("/system/health")
def system_health():
    conn = get_conn()
    cps = conn.execute(
        "SELECT chain_id, last_block FROM checkpoints ORDER BY chain_id").fetchall()
    lag_rows = []
    for cid, last in cps:
        head = conn.execute(
            "SELECT MAX(number) FROM blocks WHERE chain_id=%s", (cid,)).fetchone()[0]
        lag_rows.append({"chain_id": cid, "checkpoint": last,
                         "latest_stored_block": head,
                         "lag": (head - last) if head is not None else None})
    ph = conn.execute(
        "SELECT provider, chain_id, latency_ms, errors, ts FROM provider_health "
        "ORDER BY ts DESC LIMIT 10").fetchall()
    streams: dict = {}
    r = get_redis()
    for name in ("nexus:events", "nexus:pending", "nexus:alerts"):
        try:
            streams[name] = r.xlen(name) if r is not None else None
        except Exception:
            streams[name] = None
    return {"checkpoints": lag_rows,
            "provider_health": [{"provider": p, "chain_id": c, "latency_ms": l,
                                 "errors": e, "ts": str(t)} for p, c, l, e, t in ph],
            "streams": streams}
