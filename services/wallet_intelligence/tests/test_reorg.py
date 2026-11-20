"""Reorg propagation: block_removed invalidates wallet_transfers and emits
a reorg_invalidation alert referencing the withdrawn alerts."""
import logging

from alerts import AlertSink
from consumer import process_event
from models import NormalizedEvent
from transfers import TRANSFER_TOPIC0

from conftest import FakeRedis, FakeStore

LOG = logging.getLogger("t")
WETH = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2"
BH = "0xblockorphan"


def _topic(a):
    return "0x" + a[2:].rjust(64, "0")


def _whale_ev():
    return NormalizedEvent(
        chain_id=1, kind="log", dedup_key=f"1:{BH}:0xwtx:0", block_number=100,
        block_hash=BH, tx_hash="0xwtx", log_index=0,
        payload={
            "contract": WETH,
            "topics": [TRANSFER_TOPIC0, _topic("0xa"), _topic("0xb")],
            "data": hex(100 * 10**18),
        },
    )


def test_block_removed_invalidates():
    store, r = FakeStore(), FakeRedis()
    sink = AlertSink(store, r, LOG)
    # Ingest a whale transfer in block BH -> transfer row + whale alert.
    process_event(_whale_ev(), store, sink, 100.0, LOG)
    assert len(store.transfers) == 1
    assert len(store.alerts) == 1

    removed = NormalizedEvent(
        chain_id=1, kind="block_removed", dedup_key=f"1:{BH}:removed",
        block_hash=BH, payload={"block_hash": BH, "block_number": 100},
    )
    assert process_event(removed, store, sink, 100.0, LOG) is True
    assert store.transfers == []
    # whale alert stays, plus one reorg_invalidation referencing it
    assert len(store.alerts) == 2
    inv = store.alerts[1][1]
    assert "reorg_invalidation" in inv
    assert BH in inv
    assert "orphaned by reorg" in inv

    # Replaying block_removed must not emit a second invalidation alert.
    process_event(removed, store, sink, 100.0, LOG)
    assert len(store.alerts) == 2
