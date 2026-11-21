import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from models import TransferRecord  # noqa: E402


class FakeStore:
    """In-memory WalletStore for tests."""

    def __init__(self):
        self.transfers = []
        self.wallets = {}
        self.watchlists = []
        self.alerts = []
        self.scores = {}
        self.relations = {}
        self.failed = {}
        self.pools = set()
        self.commits = 0

    def insert_transfer(self, t: TransferRecord) -> bool:
        key = (t.chain_id, t.tx_hash, t.token, t.sender, t.recipient, t.amount)
        for e in self.transfers:
            if key == (e.chain_id, e.tx_hash, e.token, e.sender, e.recipient, e.amount):
                return False
        self.transfers.append(t)
        return True

    def upsert_wallet_first_seen(self, address, label=None):
        self.wallets.setdefault(address.lower(), {"label": label, "label_source": "wallet_intelligence" if label else None})

    def _rows(self, chain_id):
        return [
            {"chain_id": t.chain_id, "token": t.token, "sender": t.sender,
             "recipient": t.recipient, "amount": t.amount, "tx_hash": t.tx_hash,
             "block_number": t.block_number, "ts": None}
            for t in self.transfers if t.chain_id == chain_id
        ]

    def transfers_for(self, chain_id, address):
        return [r for r in self._rows(chain_id) if r["sender"] == address or r["recipient"] == address]

    def all_transfers(self, chain_id):
        return self._rows(chain_id)

    def get_watchlists(self, kind=None):
        return [w for w in self.watchlists if kind is None or w["kind"] == kind]

    def delete_transfers_by_block(self, chain_id, block_hash):
        before = len(self.transfers)
        self.transfers = [t for t in self.transfers
                          if not (t.chain_id == chain_id and t.block_hash == block_hash)]
        return before - len(self.transfers)

    def alert_keys_referencing(self, needle):
        return [k for k, _, _ in self.alerts if needle in k]

    def get_wallet_label(self, address):
        w = self.wallets.get(address.lower())
        return (w["label"], w["label_source"]) if w else (None, None)

    def failed_tx_count(self, chain_id, sender):
        return self.failed.get((chain_id, sender))

    def failed_tx_counts(self, chain_id):
        return {s: n for (c, s), n in self.failed.items() if c == chain_id}

    def transfer_chain_ids(self):
        return sorted({t.chain_id for t in self.transfers})

    def known_pool_addresses(self, chain_id):
        return self.pools

    def has_alert(self, dedup_key):
        return any(k == dedup_key for k, _, _ in self.alerts)

    def insert_alert(self, rec, message):
        if self.has_alert(rec.dedup_key):
            return False
        self.alerts.append((rec.dedup_key, "nexus:alerts", message))
        return True

    def upsert_score(self, address, chain_id, score, coverage, components):
        self.scores[(address, chain_id)] = {"score": score, "coverage": coverage, "components": components}

    def upsert_relation(self, a, b, chain_id, signals, confidence, alternatives):
        self.relations[tuple(sorted([a, b])) + (chain_id,)] = {
            "signals": signals, "confidence": confidence, "alternatives": alternatives,
        }

    def prune_scores(self, chain_id, keep):
        drop = [k for k in self.scores if k[1] == chain_id and k[0] not in set(keep)]
        for k in drop:
            del self.scores[k]
        return len(drop)

    def prune_relations(self, chain_id, keep):
        keep = {tuple(sorted(p)) for p in keep}
        drop = [k for k in self.relations if k[2] == chain_id and (k[0], k[1]) not in keep]
        for k in drop:
            del self.relations[k]
        return len(drop)

    def commit(self):
        self.commits += 1

    def rollback(self):
        pass

    def close(self):
        pass


class FakeRedis:
    def __init__(self):
        self.streams = {}
        self.lists = {}
        self.acked = []

    def xadd(self, stream, fields):
        self.streams.setdefault(stream, []).append(fields)
        return "0-1"

    def xack(self, stream, group, *ids):
        self.acked.extend(ids)

    def rpush(self, key, *values):
        self.lists.setdefault(key, []).extend(values)

    def xgroup_create(self, *a, **k):
        pass

    def xreadgroup(self, *a, **k):
        return []

    def xautoclaim(self, *a, **k):
        return ("0-0", [])


@pytest.fixture
def store():
    return FakeStore()


@pytest.fixture
def rconn():
    return FakeRedis()


def make_transfer(**kw) -> TransferRecord:
    base = dict(
        chain_id=1,
        token="0xtoken",
        sender="0xa",
        recipient="0xb",
        amount=100,
        tx_hash="0xtx1",
        block_number=100,
        log_index=0,
        dedup_key="1:bh:0xtx1:0",
    )
    base.update(kw)
    return TransferRecord(**base)
