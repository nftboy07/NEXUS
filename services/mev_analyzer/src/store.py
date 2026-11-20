"""Postgres access for Engine 5. MevStore is a protocol; production uses
PgMevStore (psycopg), tests inject fakes."""
from __future__ import annotations

import json
from typing import Optional, Protocol

import psycopg


class MevStore(Protocol):
    def txs_in_block(self, chain_id: int, block: int) -> list[dict]: ...
    def swaps_in_block(self, chain_id: int, block: int) -> list[dict]: ...
    def reserves_at(self, pool_id: str, block: int) -> Optional[dict]: ...
    def liquidation_logs(self, chain_id: int, block: int, contracts: set[str]) -> list[dict]: ...
    def cursor(self, chain_id: int) -> Optional[int]: ...
    def set_cursor(self, chain_id: int, block: int) -> None: ...
    def checkpoint(self, chain_id: int) -> Optional[int]: ...
    def insert_finding(self, f) -> bool: ...
    def insert_alert(self, destination: str, message: str) -> None: ...
    def has_alert(self, dedup_key: str) -> bool: ...
    def commit(self) -> None: ...


class PgMevStore:
    def __init__(self, dsn: str):
        self.conn = psycopg.connect(dsn, autocommit=False)

    def _rows(self, sql, params):
        cur = self.conn.execute(sql, params)
        cols = [d.name for d in cur.description]
        return [dict(zip(cols, r)) for r in cur.fetchall()]

    def txs_in_block(self, chain_id, block):
        # transactions has no position column; order by hash for determinism.
        return self._rows(
            "SELECT hash, sender, block_number, value FROM transactions "
            "WHERE chain_id=%s AND block_number=%s ORDER BY hash",
            (chain_id, block))

    def swaps_in_block(self, chain_id, block):
        # Engine 4 liquidity_events (swap rows carry amount0/amount1 inputs).
        return self._rows(
            "SELECT le.pool_id, le.event_type, le.amount0, le.amount1, le.tx_hash, "
            "       t.sender, le.block_number "
            "FROM liquidity_events le LEFT JOIN transactions t "
            "  ON t.chain_id=%s AND t.hash=le.tx_hash "
            "WHERE le.block_number=%s AND le.event_type='swap' "
            "ORDER BY le.tx_hash",
            (chain_id, block))

    def reserves_at(self, pool_id, block):
        rows = self._rows(
            "SELECT pool_id, reserve0, reserve1, block_number FROM pool_reserves "
            "WHERE pool_id=%s AND block_number<=%s AND reserve0 IS NOT NULL "
            "ORDER BY block_number DESC LIMIT 1",
            (pool_id, block))
        return rows[0] if rows else None

    def liquidation_logs(self, chain_id, block, contracts):
        if not contracts:
            return []
        return self._rows(
            "SELECT transaction_hash, block_number, contract, topics, data, log_index "
            "FROM logs WHERE chain_id=%s AND block_number=%s "
            "AND contract = ANY(%s) AND removed=FALSE ORDER BY log_index",
            (chain_id, block, sorted(contracts)))

    def cursor(self, chain_id):
        rows = self._rows("SELECT last_block FROM mev_analyzer_cursor WHERE chain_id=%s", (chain_id,))
        return rows[0]["last_block"] if rows else None

    def set_cursor(self, chain_id, block):
        self.conn.execute(
            "INSERT INTO mev_analyzer_cursor (chain_id, last_block) VALUES (%s,%s) "
            "ON CONFLICT (chain_id) DO UPDATE SET last_block=%s",
            (chain_id, block, block))

    def checkpoint(self, chain_id):
        rows = self._rows("SELECT last_block FROM checkpoints WHERE chain_id=%s", (chain_id,))
        return rows[0]["last_block"] if rows else None

    def insert_finding(self, f) -> bool:
        cur = self.conn.execute(
            "INSERT INTO mev_findings (chain_id, block_number, kind, initiator, victim, "
            " pool_id, evidence, estimated_impact, confidence) "
            "VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s) ON CONFLICT DO NOTHING",
            (f.chain_id, f.block_number, f.kind, f.initiator, f.victim, f.pool_id,
             json.dumps(f.evidence), json.dumps(f.estimated_impact),
             f.confidence.model_dump_json()))
        return cur.rowcount > 0

    def insert_alert(self, destination, message):
        self.conn.execute(
            "INSERT INTO alerts (destination, message, delivery_state) VALUES (%s,%s,'pending')",
            (destination, message))

    def has_alert(self, dedup_key):
        cur = self.conn.execute(
            "SELECT 1 FROM alerts WHERE message LIKE %s LIMIT 1", (f"%{dedup_key}%",))
        return cur.fetchone() is not None

    def commit(self):
        self.conn.commit()
