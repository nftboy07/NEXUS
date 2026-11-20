import logging
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from models import AlertRecord


@pytest.fixture
def record():
    return AlertRecord(
        source_engine="dex_monitor", kind="large_add", chain_id=1,
        title="LARGE ADD: WETH/USDC",
        facts={"tx_hash": "0xabc", "block": 19000000, "pool": "0xp", "amount": "1000"},
        assessment={"confidence": "high", "alternatives": [], "missing_info": []},
        dedup_key="1:0xabc:large_add", created_at="2024-01-01T00:00:00Z")


@pytest.fixture
def pending_record(record):
    return record.model_copy(update={"source_engine": "mempool_listener",
                                     "kind": "watchlist_swap", "dedup_key": "1:0xdef:pending"})


class FakeStore:
    """In-memory DeliveryStore: alerts keyed by dedup_key, per-channel
    states keyed by (alert_id, channel)."""

    def __init__(self):
        self.alerts = {}        # dedup_key -> alert_id
        self.states = {}        # alert_id -> aggregate delivery_state
        self.channels = {}      # (alert_id, channel) -> state
        self._next = 1

    def alert_id(self, rec):
        if rec.dedup_key not in self.alerts:
            self.alerts[rec.dedup_key] = self._next
            self._next += 1
        return self.alerts[rec.dedup_key]

    def channel_state(self, alert_id, channel):
        return self.channels.get((alert_id, channel))

    def set_channel_state(self, alert_id, channel, state, attempts, error=None):
        self.channels[(alert_id, channel)] = state

    def set_delivery_state(self, alert_id, state):
        self.states[alert_id] = state

    def commit(self):
        pass


@pytest.fixture
def store():
    return FakeStore()


@pytest.fixture
def log():
    lg = logging.getLogger("test_dispatcher")
    lg.handlers = []
    lg.addHandler(logging.NullHandler())
    return lg
