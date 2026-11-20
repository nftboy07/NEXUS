import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))


class FakeStore:
    def __init__(self):
        self.txs = {}          # block -> [rows]
        self.swaps = {}        # block -> [rows]
        self.reserves = {}     # pool_id -> reserve row
        self.liq_logs = {}
        self.findings = []
        self.alerts = []
        self.cursors = {}
        self.checkpoints = {}

    def txs_in_block(self, chain_id, block):
        return self.txs.get((chain_id, block), [])

    def swaps_in_block(self, chain_id, block):
        return self.swaps.get((chain_id, block), [])

    def reserves_at(self, pool_id, block):
        return self.reserves.get(pool_id)

    def liquidation_logs(self, chain_id, block, contracts):
        return [l for l in self.liq_logs.get((chain_id, block), []) if l["contract"].lower() in contracts]

    def cursor(self, chain_id):
        return self.cursors.get(chain_id)

    def set_cursor(self, chain_id, block):
        self.cursors[chain_id] = block

    def checkpoint(self, chain_id):
        return self.checkpoints.get(chain_id)

    def insert_finding(self, f):
        key = (f.kind, f.chain_id, f.block_number, f.initiator, f.pool_id)
        if any((x.kind, x.chain_id, x.block_number, x.initiator, x.pool_id) == key for x in self.findings):
            return False
        self.findings.append(f)
        return True

    def insert_alert(self, destination, message):
        self.alerts.append((destination, message))

    def has_alert(self, dedup_key):
        return any(dedup_key in m for _, m in self.alerts)

    def commit(self):
        pass


@pytest.fixture
def store():
    return FakeStore()


def swap(tx_hash, sender, pool, a0, a1, block=100):
    return {"tx_hash": tx_hash, "sender": sender, "pool_id": pool,
            "amount0": a0, "amount1": a1, "block_number": block}
