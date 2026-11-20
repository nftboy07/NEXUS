"""End-to-end replay: fixture events through process_event -> transfers,
whale alert, profile, score — each exactly once on replay."""
import json
import logging
from pathlib import Path

from alerts import AlertSink
from consumer import process_event
from models import NormalizedEvent
from profiles import build_profile
from scoring import compute_score

from conftest import FakeRedis, FakeStore

LOG = logging.getLogger("t")
FIXTURE = Path(__file__).parent / "fixtures" / "transfers.json"


def _events():
    return [NormalizedEvent.model_validate(e) for e in json.loads(FIXTURE.read_text())]


def test_replay_end_to_end():
    store, r = FakeStore(), FakeRedis()
    sink = AlertSink(store, r, LOG)
    evs = _events()
    assert len(evs) == 4

    for ev in evs:
        process_event(ev, store, sink, 100.0, LOG)
    for ev in evs:  # replay
        process_event(ev, store, sink, 100.0, LOG)

    # 4 transfers stored once each (wallet_transfers dedup)
    assert len(store.transfers) == 4
    # exactly one whale alert (the WETH >= 100 ETH transfer), not two
    assert len(store.alerts) == 1
    assert len(r.streams["nexus:alerts"]) == 1
    assert "whale" in json.loads(store.alerts[0][1])["kind"]

    # profile + score for the whale recipient
    p = build_profile(store, 1, "0x0000000000000000000000000000000000000b0b")
    assert p.tx_count_in == 1
    rows = [x for x in store.all_transfers(1) if x["recipient"] == "0x0000000000000000000000000000000000000b0b" or x["sender"] == "0x0000000000000000000000000000000000000b0b"]
    s = compute_score("0x0000000000000000000000000000000000000b0b", 1, rows, {"0xt1": [101]}, None)
    assert s.components.realized_performance.value is None
    store.upsert_score("0x0000000000000000000000000000000000000b0b", 1, s.score, s.coverage, s.components.model_dump())
    assert ("0x0000000000000000000000000000000000000b0b", 1) in store.scores
