"""Postgres access for Engine 5. MevStore is a protocol; production uses
PgMevStore (psycopg), tests inject fakes.

All block-scoped reads resolve block numbers through Engine 1's `blocks`
table (logs carry block_hash, not number) and skip hashes listed in
`removed_blocks` (orphaned by a reorg)."""
from __future__ import annotations

import json
from typing import Optional, Protocol

import psycopg

from findings import ALERTS_DESTINATION
from swaps import DEX_TOPICS, V3_SWAP, _words

CANONICAL = ("JOIN blocks b ON b.chain_id = l.chain_id AND b.hash = l.block_hash "
             "AND NOT EXISTS (SELECT 1 FROM removed_blocks rb WHERE rb.chain_id = b.chain_id "
             "AND rb.block_hash = b.hash) ")


class MevStore(Protocol):
    def swap_logs(self, chain_id: int, from_block: int, to_block: int) -> list[dict]: ...
    def prev_v3_sqrt(self, pool_id: str, block: int) -> Optional[int]: ...
    def liquidation_logs(self, chain_id: int, from_block: int, to_block: int, contracts: set[str]) -> list[dict]: ...
    def cursor(self, chain_id: int) -> Optional[int]: ...
    def set_cursor(self, chain_id: int, block: int) -> None: ...
    def checkpoint(self, chain_id: int) -> Optional[int]: ...
    def insert_finding(self, f) -> bool: ...
    def insert_alert(self, record: dict, message: str) -> bool: ...
    def commit(self) -> None: ...


class PgMevStore:
    def __init__(self, dsn: str):
        self.conn = psycopg.connect(dsn, autocommit=False)

    def _rows(self, sql, params):
        cur = self.conn.execute(sql, params)
        cols = [d.name for d in cur.description]
        return [dict(zip(cols, r)) for r in cur.fetchall()]

    def swap_logs(self, chain_id, from_block, to_block):
        """Swap/Sync logs on registered pools, ordered by (block, log_index)."""
        return self._rows(
            "SELECT l.chain_id, b.number AS block_number, l.transaction_hash AS tx_hash, l.log_index, "
            "       l.topics, l.data, p.id AS pool_id, p.dex, p.token0, p.token1, t.sender "
            "FROM logs l " + CANONICAL +
            "JOIN pools p ON p.chain_id = l.chain_id AND p.id = l.chain_id || ':' || lower(l.contract) "
            "LEFT JOIN transactions t ON t.chain_id = l.chain_id AND t.hash = l.transaction_hash "
            "WHERE l.chain_id = %s AND b.number BETWEEN %s AND %s AND l.removed = FALSE "
            "  AND l.topics->>0 = ANY(%s) "
            "ORDER BY b.number, l.log_index",
            (chain_id, from_block, to_block, list(DEX_TOPICS)))

    def prev_v3_sqrt(self, pool_id, block):
        chain_id, addr = pool_id.split(":", 1)
        rows = self._rows(
            "SELECT l.data FROM logs l " + CANONICAL +
            "WHERE l.chain_id = %s AND lower(l.contract) = %s AND b.number < %s "
            "  AND l.removed = FALSE AND l.topics->>0 = %s "
            "ORDER BY b.number DESC, l.log_index DESC LIMIT 1",
            (int(chain_id), addr.lower(), block, V3_SWAP))
        if not rows:
            return None
        w = _words(rows[0]["data"])
        return w[2] if len(w) >= 3 else None

    def liquidation_logs(self, chain_id, from_block, to_block, contracts):
        if not contracts:
            return []
        return self._rows(
            "SELECT l.transaction_hash, b.number AS block_number, l.contract, l.topics, l.data, l.log_index "
            "FROM logs l " + CANONICAL +
            "WHERE l.chain_id = %s AND b.number BETWEEN %s AND %s "
            "  AND lower(l.contract) = ANY(%s) AND l.removed = FALSE ORDER BY b.number, l.log_index",
            (chain_id, from_block, to_block, sorted(contracts)))

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

    def insert_alert(self, record: dict, message: str) -> bool:
        """Insert with identity columns; False when dedup_key already existed."""
        cur = self.conn.execute(
            "INSERT INTO alerts (dedup_key, source_engine, kind, chain_id, record, destination, message, delivery_state) "
            "VALUES (%s,%s,%s,%s,%s,%s,%s,'pending') "
            "ON CONFLICT (dedup_key) WHERE dedup_key IS NOT NULL DO NOTHING",
            (record["dedup_key"], record["source_engine"], record["kind"],
             record["chain_id"], message, ALERTS_DESTINATION, message))
        return cur.rowcount > 0

    def commit(self):
        self.conn.commit()

    def rollback(self):
        self.conn.rollback()

    def close(self):
        self.conn.close()
