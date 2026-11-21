"""Postgres access for Engine 3. WalletStore is a protocol — tests inject
fakes; production uses PgWalletStore (psycopg)."""
from __future__ import annotations

from typing import Optional, Protocol

import psycopg

from models import TransferRecord


class WalletStore(Protocol):
    def insert_transfer(self, t: TransferRecord) -> bool: ...
    def upsert_wallet_first_seen(self, address: str, label: Optional[str] = None) -> None: ...
    def transfers_for(self, chain_id: int, address: str) -> list[dict]: ...
    def all_transfers(self, chain_id: int) -> list[dict]: ...
    def get_watchlists(self, kind: str | None = None) -> list[dict]: ...
    def get_wallet_label(self, address: str) -> tuple[Optional[str], Optional[str]]: ...
    def delete_transfers_by_block(self, chain_id: int, block_hash: str) -> int: ...
    def alert_keys_referencing(self, needle: str) -> list[str]: ...
    def failed_tx_count(self, chain_id: int, sender: str) -> Optional[int]: ...
    def failed_tx_counts(self, chain_id: int) -> dict[str, int]: ...
    def transfer_chain_ids(self) -> list[int]: ...
    def known_pool_addresses(self, chain_id: int) -> set[str]: ...
    def has_alert(self, dedup_key: str) -> bool: ...
    def insert_alert(self, destination: str, message: str) -> None: ...
    def upsert_score(self, address: str, chain_id: int, score, coverage, components) -> None: ...
    def upsert_relation(self, a: str, b: str, chain_id: int, signals, confidence, alternatives) -> None: ...
    def prune_scores(self, chain_id: int, keep: list[str]) -> int: ...
    def prune_relations(self, chain_id: int, keep: list[tuple[str, str]]) -> int: ...
    def commit(self) -> None: ...
    def rollback(self) -> None: ...
    def close(self) -> None: ...


class PgWalletStore:
    def __init__(self, dsn: str):
        self.conn = psycopg.connect(dsn, autocommit=False)

    def insert_transfer(self, t: TransferRecord) -> bool:
        cur = self.conn.execute(
            """INSERT INTO wallet_transfers
                 (chain_id, token, sender, recipient, amount, tx_hash, block_number, block_hash, ts)
               VALUES (%s,%s,%s,%s,%s,%s,%s,%s, now())
               ON CONFLICT (chain_id, tx_hash, token, sender, recipient, amount) DO NOTHING""",
            (t.chain_id, t.token, t.sender, t.recipient, t.amount, t.tx_hash, t.block_number, t.block_hash),
        )
        return cur.rowcount > 0

    def upsert_wallet_first_seen(self, address: str, label: Optional[str] = None) -> None:
        self.conn.execute(
            """INSERT INTO wallets (address, label, label_source, first_seen)
               VALUES (%s,%s,%s, now())
               ON CONFLICT (address) DO NOTHING""",
            (address, label, "wallet_intelligence" if label else None),
        )

    def transfers_for(self, chain_id: int, address: str) -> list[dict]:
        cur = self.conn.execute(
            """SELECT chain_id, token, sender, recipient, amount, tx_hash, block_number, ts
               FROM wallet_transfers
               WHERE chain_id = %s AND (sender = %s OR recipient = %s)
               ORDER BY block_number""",
            (chain_id, address, address),
        )
        cols = [d.name for d in cur.description]
        return [dict(zip(cols, r)) for r in cur.fetchall()]

    def all_transfers(self, chain_id: int) -> list[dict]:
        cur = self.conn.execute(
            """SELECT chain_id, token, sender, recipient, amount, tx_hash, block_number, ts
               FROM wallet_transfers WHERE chain_id = %s ORDER BY block_number""",
            (chain_id,),
        )
        cols = [d.name for d in cur.description]
        return [dict(zip(cols, r)) for r in cur.fetchall()]

    def get_watchlists(self, kind: str | None = None) -> list[dict]:
        if kind is None:
            cur = self.conn.execute("SELECT id, kind, value, note FROM watchlists")
        else:
            cur = self.conn.execute("SELECT id, kind, value, note FROM watchlists WHERE kind = %s", (kind,))
        cols = [d.name for d in cur.description]
        return [dict(zip(cols, r)) for r in cur.fetchall()]

    def get_wallet_label(self, address: str) -> tuple[Optional[str], Optional[str]]:
        cur = self.conn.execute("SELECT label, label_source FROM wallets WHERE address = %s", (address,))
        row = cur.fetchone()
        return (row[0], row[1]) if row else (None, None)

    def failed_tx_count(self, chain_id: int, sender: str) -> Optional[int]:
        """Reverted txs sent by `sender`; None when no transactions rows exist
        for it (unobserved, not zero)."""
        cur = self.conn.execute(
            "SELECT COUNT(*), COUNT(*) FILTER (WHERE status = 'reverted') "
            "FROM transactions WHERE chain_id = %s AND sender = %s",
            (chain_id, sender),
        )
        total, reverted = cur.fetchone()
        return reverted if total else None

    def failed_tx_counts(self, chain_id: int) -> dict[str, int]:
        """sender -> reverted tx count, for every sender with transactions
        rows on the chain. Absent key = unobserved (None), not zero."""
        cur = self.conn.execute(
            "SELECT lower(sender), COUNT(*) FILTER (WHERE status = 'reverted') "
            "FROM transactions WHERE chain_id = %s AND sender IS NOT NULL GROUP BY 1",
            (chain_id,),
        )
        return {r[0]: r[1] for r in cur.fetchall()}

    def transfer_chain_ids(self) -> list[int]:
        cur = self.conn.execute(
            "SELECT DISTINCT chain_id FROM wallet_transfers WHERE chain_id IS NOT NULL ORDER BY 1")
        return [r[0] for r in cur.fetchall()]

    def known_pool_addresses(self, chain_id: int) -> set[str]:
        try:
            cur = self.conn.execute("SELECT id FROM pools WHERE chain_id = %s", (chain_id,))
            return {r[0].split(":", 1)[1] for r in cur.fetchall() if ":" in r[0]}
        except psycopg.Error:
            self.conn.rollback()
            return set()

    def delete_transfers_by_block(self, chain_id: int, block_hash: str) -> int:
        cur = self.conn.execute(
            "DELETE FROM wallet_transfers WHERE chain_id = %s AND block_hash = %s",
            (chain_id, block_hash),
        )
        return cur.rowcount

    def alert_keys_referencing(self, needle: str) -> list[str]:
        cur = self.conn.execute("SELECT dedup_key FROM alerts WHERE dedup_key LIKE %s", (f"%{needle}%",))
        return [r[0] for r in cur.fetchall()]

    def has_alert(self, dedup_key: str) -> bool:
        cur = self.conn.execute("SELECT 1 FROM alerts WHERE dedup_key = %s LIMIT 1", (dedup_key,))
        return cur.fetchone() is not None

    def insert_alert(self, rec, message: str) -> bool:
        """Insert with identity columns; False when dedup_key already existed."""
        cur = self.conn.execute(
            "INSERT INTO alerts (dedup_key, source_engine, kind, chain_id, record, destination, message, delivery_state) "
            "VALUES (%s,%s,%s,%s,%s,%s,%s,'pending') "
            "ON CONFLICT (dedup_key) WHERE dedup_key IS NOT NULL DO NOTHING",
            (rec.dedup_key, rec.source_engine, rec.kind, rec.chain_id, message, "nexus:alerts", message),
        )
        return cur.rowcount > 0

    def upsert_score(self, address, chain_id, score, coverage, components) -> None:
        import json

        self.conn.execute(
            """INSERT INTO wallet_scores (address, chain_id, score, coverage, components, computed_at)
               VALUES (%s,%s,%s,%s,%s, now())
               ON CONFLICT (address, chain_id) DO UPDATE
               SET score=%s, coverage=%s, components=%s, computed_at=now()""",
            (address, chain_id, score, json.dumps(coverage), json.dumps(components),
             score, json.dumps(coverage), json.dumps(components)),
        )

    def upsert_relation(self, a, b, chain_id, signals, confidence, alternatives) -> None:
        import json

        a, b = sorted([a, b])
        self.conn.execute(
            """INSERT INTO wallet_relations (address_a, address_b, chain_id, signals, confidence, alternatives)
               VALUES (%s,%s,%s,%s,%s,%s)
               ON CONFLICT (address_a, address_b, chain_id) DO UPDATE
               SET signals=%s, confidence=%s, alternatives=%s""",
            (a, b, chain_id, json.dumps(signals), confidence, json.dumps(alternatives),
             json.dumps(signals), confidence, json.dumps(alternatives)),
        )

    def prune_scores(self, chain_id: int, keep: list[str]) -> int:
        """Drop scores for wallets no longer backed by stored transfers (e.g.
        after a reorg deleted their rows)."""
        cur = self.conn.execute(
            "DELETE FROM wallet_scores WHERE chain_id = %s AND NOT (address = ANY(%s))",
            (chain_id, list(keep)),
        )
        return cur.rowcount

    def prune_relations(self, chain_id: int, keep: list[tuple[str, str]]) -> int:
        """Drop hypotheses the latest full recompute no longer supports;
        surviving rows keep their original created_at."""
        keys = [f"{a}|{b}" for a, b in keep]
        cur = self.conn.execute(
            "DELETE FROM wallet_relations WHERE chain_id = %s AND NOT (address_a || '|' || address_b = ANY(%s))",
            (chain_id, keys),
        )
        return cur.rowcount

    def commit(self) -> None:
        self.conn.commit()

    def rollback(self) -> None:
        self.conn.rollback()

    def close(self) -> None:
        self.conn.close()
