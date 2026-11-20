import logging

from alerts import AlertSink
from whale import ETH, WETH, check_transfer

from conftest import make_transfer


def test_at_threshold_alerts(store, rconn):
    sink = AlertSink(store, rconn, logging.getLogger("t"))
    t = make_transfer(token=WETH[1], amount=int(100 * ETH))
    alert = check_transfer(t, [], 100.0)
    assert alert is not None
    assert alert.kind == "whale_transfer"
    assert alert.facts["tx_hash"] == "0xtx1"
    assert sink.emit(alert)
    assert len(store.alerts) == 1
    assert rconn.streams["nexus:alerts"][0]["dedup_key"].startswith("wallet_intelligence:whale_transfer:")


def test_one_wei_below_no_alert(store, rconn):
    t = make_transfer(token=WETH[1], amount=int(100 * ETH) - 1)
    assert check_transfer(t, [], 100.0) is None


def test_replay_dedup(store, rconn):
    sink = AlertSink(store, rconn, logging.getLogger("t"))
    t = make_transfer(token=WETH[1], amount=int(100 * ETH))
    alert = check_transfer(t, [], 100.0)
    assert sink.emit(alert) is True
    assert sink.emit(alert) is False
    assert len(store.alerts) == 1
    assert len(rconn.streams["nexus:alerts"]) == 1


def test_watchlist_wallet(store, rconn):
    store.watchlists.append({"id": 1, "kind": "wallet", "value": "0xa", "note": ""})
    t = make_transfer(amount=1)
    alert = check_transfer(t, store.get_watchlists(), 100.0)
    assert alert is not None and alert.facts["rule"] == "watchlist wallet"


def test_watchlist_min_amount(store, rconn):
    store.watchlists.append({"id": 2, "kind": "min_amount", "value": "0xtoken:50", "note": ""})
    t = make_transfer(amount=50)
    assert check_transfer(t, store.get_watchlists(), 100.0) is not None
    t2 = make_transfer(amount=49)
    assert check_transfer(t2, store.get_watchlists(), 100.0) is None


def test_valuation_source_stated(store, rconn):
    t = make_transfer(token=WETH[1], amount=int(100 * ETH))
    alert = check_transfer(t, [], 100.0)
    assert "no USD price source" in alert.facts["valuation_source"]
