import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

FIX = Path(__file__).parent / "fixtures"


class FakeCursor:
    def __init__(self, rows, cols):
        self.description = [type("D", (), {"name": c}) for c in cols]
        # rows may be dicts — normalize to tuples in column order
        self._rows = [tuple(r[c] for c in cols) if isinstance(r, dict) else r for r in rows]

    def fetchall(self):
        return self._rows

    def fetchone(self):
        return self._rows[0] if self._rows else None


class FakeConn:
    """Canned Postgres for package tests — labeled fixture DB rows."""

    TX = {"hash": "0xtx1", "sender": "0xalice", "recipient": "0xrouter",
          "value": "1000", "status": "success", "block_number": "100", "nonce": "7"}
    BLOCK = {"number": 100, "hash": "0xbh", "parent_hash": "0xpbh", "ts": "t"}
    LOGS = [{"contract": "0xtoken", "topics": ["0xt"], "data": "0x0", "log_index": 0, "removed": False}]
    TRANSFERS = [{"token": "0xt", "sender": "0xalice", "recipient": "0xbob",
                  "amount": "50", "tx_hash": "0xtx1", "block_number": 100}]
    WALLETS = {"0xalice": {"label": "alice-lab", "label_source": "manual"}}
    SCORES = {}
    RELATIONS = []

    def execute(self, sql, params=()):
        s = " ".join(sql.split())
        if "FROM transactions" in s:
            return FakeCursor([self.TX] if params[1] == "0xtx1" else [],
                              ["hash", "sender", "recipient", "value", "status", "block_number", "nonce"])
        if "FROM blocks" in s:
            return FakeCursor([self.BLOCK], ["number", "hash", "parent_hash", "ts"])
        if "FROM logs" in s:
            return FakeCursor(self.LOGS, ["contract", "topics", "data", "log_index", "removed"])
        if "FROM wallet_transfers" in s and "direction" in s:
            return FakeCursor([{"direction": "out", "c": 3}], ["direction", "c"])
        if "FROM wallet_transfers" in s:
            return FakeCursor(self.TRANSFERS, ["token", "sender", "recipient", "amount", "tx_hash", "block_number"])
        if "FROM wallets" in s:
            return FakeCursor([self.WALLETS[params[0]]] if params[0] in self.WALLETS else [],
                              ["label", "label_source"])
        if "FROM wallet_scores" in s:
            return FakeCursor(self.SCORES.get(params[0], []), ["score", "coverage"])
        if "FROM wallet_relations" in s:
            return FakeCursor(self.RELATIONS, ["address_a", "address_b", "signals", "confidence", "alternatives"])
        raise AssertionError(f"unexpected query: {s}")

    def rollback(self):
        pass

    def commit(self):
        pass


@pytest.fixture
def conn():
    return FakeConn()


@pytest.fixture
def package(conn):
    from package import build_package
    return build_package(conn, 1, "0xtx1")


def stub_response(content: dict | str) -> dict:
    return {
        "content": content if isinstance(content, str) else json.dumps(content),
        "input_tokens": 120, "output_tokens": 40, "model": "stub-model",
    }
