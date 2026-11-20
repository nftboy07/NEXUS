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
    def __init__(self):
        self.states = {}
        self.errors = {}

    def delivery_state(self, key):
        return self.states.get(key)

    def set_delivery_state(self, key, state, error=None):
        self.states[key] = state
        self.errors[key] = error

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
