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
    def failed_tx_count(self, chain_id: int, sender: str) -> Optional[int]: ...
    def known_pool_addresses(self, chain_id: int) -> set[str]: ...
    def has_alert(self, dedup_key: str) -> bool: ...
    def insert_alert(self, destination: str, message: str) -> None: ...
    def upsert_score(self, address: str, chain_id: int, score, coverage, components) -> None: ...
    def upsert_relation(self, a: str, b: str, chain_id: int, signals, confidence, alternatives) -> None: ...
    def commit(self) -> None: ...
    def close(self) -> None: ...


class PgWalletStore:
    def __init__(self, dsn: str):
        self.conn = psycopg.connect(dsn, autocommit=False)

    def insert_transfer(self, t: TransferRecord) -> bool:
        cur = self.conn.execute(
            """INSERT INTO wallet_transfers
                 (chain_id, token, sender, recipient, amount, tx_hash, block_number, ts)
               VALUES (%s,%s,%s,%s,%s,%s,%s, now())
               ON CONFLICT (chain_id, tx_hash, token, sender, recipient, amount) DO NOTHING""",
            (t.chain_id, t.token, t.sender, t.recipient, t.amount, t.tx_hash, t.block_number),
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
        cur = self.conn.execute(
            "SELECT COUNT(*) FROM transactions WHERE chain_id = %s AND sender = %s AND status = 'reverted'",
            (chain_id, sender),
        )
        return cur.fetchone()[0]

    def known_pool_addresses(self, chain_id: int) -> set[str]:
        try:
            cur = self.conn.execute("SELECT id FROM pools WHERE chain_id = %s", (chain_id,))
            return {r[0].split(":", 1)[1] for r in cur.fetchall() if ":" in r[0]}
        except psycopg.Error:
            self.conn.rollback()
            return set()

    def has_alert(self, dedup_key: str) -> bool:
        cur = self.conn.execute("SELECT 1 FROM alerts WHERE message LIKE %s LIMIT 1", (f"%{dedup_key}%",))
        return cur.fetchone() is not None

    def insert_alert(self, destination: str, message: str) -> None:
        self.conn.execute(
            "INSERT INTO alerts (destination, message, delivery_state) VALUES (%s,%s,'pending')",
            (destination, message),
        )

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

    def commit(self) -> None:
        self.conn.commit()

    def close(self) -> None:
        self.conn.close()
