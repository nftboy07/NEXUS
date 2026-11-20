import os
from conftest import AUTH


def test_pending_status_filter(client, conn):
    conn.pending = [
        (1, "0xp1", "0xs", 5, "0xr", 100, "swapExactTokensForTokens", {}, "PENDING", 100, None, None),
        (1, "0xp2", "0xs", 6, "0xr", 50, "approve", {}, "DROPPED", 99, None, None),
    ]
    rows = client.get("/pending", headers=AUTH).json()
    assert len(rows) == 2
    only = client.get("/pending?status=PENDING", headers=AUTH).json()
    assert len(only) == 1 and only[0]["status"] == "PENDING"


def test_pools_and_detail(client, conn):
    conn.pools = [("0xpool", "uniswap_v2", "0xt0", "0xt1", 1, None, 100, "pool_created")]
    conn.reserves["0xpool"] = [(1000, 2000, "sync", 150)]
    assert client.get("/pools", headers=AUTH).json()[0]["dex"] == "uniswap_v2"
    d = client.get("/pools/0xpool", headers=AUTH).json()
    assert d["latest_reserves"]["reserve0"] == "1000"
    assert client.get("/pools/0xnone", headers=AUTH).status_code == 404


def test_mev_findings(client, conn):
    conn.mev_findings = [(1, 1, 100, "sandwich", "0xa", "0xv", "0xp", {"txs": ["0xa1"]},
                          {"impact_pct": 0.5}, {"level": "high"})]
    rows = client.get("/mev?kind=sandwich", headers=AUTH).json()
    assert rows[0]["kind"] == "sandwich"
    assert rows[0]["confidence"]["level"] == "high"


def test_investigations_list_and_create(client, conn, monkeypatch):
    monkeypatch.delenv("LLM_API_KEY", raising=False)
    r = client.post("/investigations", json={"chain_id": 1, "tx_hash": "0xtx"}, headers=AUTH)
    assert r.status_code == 201
    assert r.json()["status"] == "awaiting_model"  # no LLM configured -> never fabricates
    assert client.get("/investigations", headers=AUTH).json()
    assert client.get("/investigations/999", headers=AUTH).status_code == 404
    assert client.post("/investigations", json={"chain_id": 1}, headers=AUTH).status_code == 422


def test_system_health(client, conn):
    conn.checkpoints = [(1, 190)]
    conn.blocks_max = {1: 200}
    conn.provider_health = [("rpc-a", 1, 120, 0, "2024-01-01")]
    r = client.get("/system/health", headers=AUTH)
    body = r.json()
    assert body["checkpoints"][0]["lag"] == 10
    assert body["provider_health"][0]["provider"] == "rpc-a"
    assert body["streams"]["nexus:alerts"] is None  # no redis -> honest null


def test_system_health_requires_auth(client):
    assert client.get("/system/health").status_code == 401
