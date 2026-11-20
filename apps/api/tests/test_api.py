from conftest import AUTH


def test_health_public_and_checkpoints(client, conn):
    conn.checkpoints = [(1, 19000000), (8453, 800000)]
    r = client.get("/health")
    assert r.status_code == 200
    assert r.json()["checkpoints"][0] == {"chain_id": 1, "last_block": 19000000}


def test_chains_from_config(client):
    r = client.get("/chains")
    assert r.status_code == 200
    ids = {c["id"] for c in r.json()}
    assert {1, 8453} <= ids


def test_unauthorized_401(client):
    assert client.get("/alerts").status_code == 401
    assert client.get("/alerts", headers={"X-Api-Key": "wrong"}).status_code == 401


def test_watchlist_create_list_delete(client, conn):
    r = client.post("/watchlists", json={"kind": "wallet", "value": "0xABC"}, headers=AUTH)
    assert r.status_code == 201
    rows = client.get("/watchlists", headers=AUTH).json()
    assert rows == [{"id": 1, "kind": "wallet", "value": "0xabc", "note": None}]
    assert client.delete("/watchlists/1", headers=AUTH).status_code == 200
    assert client.get("/watchlists", headers=AUTH).json() == []
    assert client.delete("/watchlists/1", headers=AUTH).status_code == 404


def test_unknown_wallet_404(client):
    assert client.get("/wallets/0xdead", headers=AUTH).status_code == 404


def test_known_wallet(client, conn):
    conn.wallet_scores["0xdead"] = (72.5, 0.6, {"early_discovery": 80})
    r = client.get("/wallets/0xDEAD", headers=AUTH)
    assert r.status_code == 200
    assert r.json()["score"] == 72.5


def test_api_key_never_in_response_or_logs(client, caplog):
    import logging
    with caplog.at_level(logging.DEBUG):
        client.get("/alerts", headers=AUTH)
    assert "test-key" not in caplog.text
