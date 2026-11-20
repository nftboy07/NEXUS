import json
import logging

from alerts import AlertSink
from consumer import Consumer, process_event
from models import NormalizedEvent
from transfers import TRANSFER_TOPIC0, decode_transfer

from conftest import FakeRedis, FakeStore

LOG = logging.getLogger("t")


def _topic(addr):
    return "0x" + addr[2:].rjust(64, "0")


def test_decode_log_kind_transfer():
    ev = NormalizedEvent(
        chain_id=1, kind="log", dedup_key="1:bh:0xtx:0",
        block_number=100, tx_hash="0xtx", log_index=0,
        payload={
            "contract": "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
            "topics": [TRANSFER_TOPIC0, _topic("0xsender"), _topic("0xrecip")],
            "data": hex(10**6),
        },
    )
    t = decode_transfer(ev)
    assert t is not None
    assert t.token == "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48"
    assert t.sender == "0x" + "sender".rjust(40, "0")
    assert t.recipient == "0x" + "recip".rjust(40, "0")
    assert t.amount == 10**6


def test_decode_transfer_kind():
    ev = NormalizedEvent(
        chain_id=8453, kind="transfer", dedup_key="8453:bh:0xtx:0",
        block_number=50, tx_hash="0xtx", log_index=0,
        payload={"token": "0xT", "from": "0xA", "to": "0xB", "value": "123"},
    )
    t = decode_transfer(ev)
    assert t.amount == 123 and t.token == "0xt"


def test_removed_and_nontransfer_ignored():
    assert decode_transfer(NormalizedEvent(
        chain_id=1, kind="log", dedup_key="k",
        payload={"contract": "0xc", "topics": ["0xother"], "data": "0x0"},
    )) is None
    assert decode_transfer(NormalizedEvent(
        chain_id=1, kind="log", dedup_key="k",
        payload={"contract": "0xc", "topics": [TRANSFER_TOPIC0, _topic("0xa"), _topic("0xb")], "data": "0x0", "removed": True},
    )) is None


def test_idempotent_persist():
    store, r = FakeStore(), FakeRedis()
    sink = AlertSink(store, r, LOG)
    ev = NormalizedEvent(
        chain_id=1, kind="log", dedup_key="1:bh:0xtx:0", block_number=100,
        tx_hash="0xtx", log_index=0,
        payload={"contract": "0xt", "topics": [TRANSFER_TOPIC0, _topic("0xa"), _topic("0xb")], "data": hex(5)},
    )
    assert process_event(ev, store, sink, 100.0, LOG) is True
    assert process_event(ev, store, sink, 100.0, LOG) is True  # replay: no crash
    assert len(store.transfers) == 1


def test_consumer_ack_and_deadletter():
    store, r = FakeStore(), FakeRedis()
    sink = AlertSink(store, r, LOG)
    c = Consumer(r, store, sink, max_retries=2, log=LOG)

    def boom(ev, *a, **k):
        raise RuntimeError("bad event")

    ev = NormalizedEvent(chain_id=1, kind="log", dedup_key="x", payload={})
    import consumer as mod
    orig = mod.process_event
    mod.process_event = boom
    try:
        for _ in range(2):
            try:
                c._handle("1-0", ev)
            except RuntimeError:
                pass
    finally:
        mod.process_event = orig
    # second failure of the same entry parks it
    assert r.lists["wallet_intelligence_deadletter"] == ["1-0"]
    assert "1-0" in r.acked
