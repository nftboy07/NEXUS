import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from swaps import V2_SWAP, V2_SYNC, V3_SWAP  # noqa: E402

T0, T1 = "0xtoken0", "0xtoken1"


def word(v: int) -> str:
    return format(v % (1 << 256), "064x")


def v2_swap_row(tx, li, pool, sender, a0in, a1in, a0out, a1out, block=100, chain_id=1, dex="uniswap_v2"):
    return {"chain_id": chain_id, "block_number": block, "tx_hash": tx, "log_index": li,
            "topics": [V2_SWAP, "0x" + "0" * 64, "0x" + "0" * 64],
            "data": "0x" + "".join(word(x) for x in (a0in, a1in, a0out, a1out)),
            "pool_id": pool, "dex": dex, "token0": T0, "token1": T1, "sender": sender}


def v2_sync_row(tx, li, pool, r0, r1, block=100, chain_id=1, dex="uniswap_v2"):
    return {"chain_id": chain_id, "block_number": block, "tx_hash": tx, "log_index": li,
            "topics": [V2_SYNC], "data": "0x" + word(r0) + word(r1),
            "pool_id": pool, "dex": dex, "token0": T0, "token1": T1, "sender": None}


def v3_swap_row(tx, li, pool, sender, a0, a1, sqrt, block=100, chain_id=1):
    return {"chain_id": chain_id, "block_number": block, "tx_hash": tx, "log_index": li,
            "topics": [V3_SWAP, "0x" + "0" * 64, "0x" + "0" * 64],
            "data": "0x" + "".join(word(x) for x in (a0, a1, sqrt, 10 ** 18, 0)),
            "pool_id": pool, "dex": "uniswap_v3", "token0": T0, "token1": T1, "sender": sender}


def v2_trade(rows, tx, pool, sender, reserves, a0in=0, a1in=0, block=100):
    """Append Sync+Swap rows for a constant-product trade; returns new reserves."""
    r0, r1 = reserves
    if a0in:
        out = a0in * 997 * r1 // (r0 * 1000 + a0in * 997)
        r0, r1, a0out, a1out = r0 + a0in, r1 - out, 0, out
    else:
        out = a1in * 997 * r0 // (r1 * 1000 + a1in * 997)
        r0, r1, a0out, a1out = r0 - out, r1 + a1in, out, 0
    li = len(rows) * 2
    rows.append(v2_sync_row(tx, li, pool, r0, r1, block))
    rows.append(v2_swap_row(tx, li + 1, pool, sender, a0in, a1in, a0out, a1out, block))
    return (r0, r1)


class FakeStore:
    def __init__(self):
        self.rows = {}         # chain_id -> [raw log rows]
        self.v3_prev = {}      # pool_id -> sqrt
        self.liq_logs = {}     # chain_id -> [rows]
        self.findings = []
        self.alerts = []
        self.cursors = {}
        self.checkpoints = {}
        self.commits = 0

    def swap_logs(self, chain_id, from_block, to_block):
        return [r for r in self.rows.get(chain_id, []) if from_block <= r["block_number"] <= to_block]

    def prev_v3_sqrt(self, pool_id, block):
        return self.v3_prev.get(pool_id)

    def liquidation_logs(self, chain_id, from_block, to_block, contracts):
        return [l for l in self.liq_logs.get(chain_id, [])
                if l["contract"].lower() in contracts and from_block <= l["block_number"] <= to_block]

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

    def insert_alert(self, record, message):
        if any(r["dedup_key"] == record["dedup_key"] for r, _ in self.alerts):
            return False
        self.alerts.append((record, message))
        return True

    def commit(self):
        self.commits += 1

    def rollback(self):
        pass


@pytest.fixture
def store():
    return FakeStore()
