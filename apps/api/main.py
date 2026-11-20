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
