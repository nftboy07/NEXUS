"""DeliveryStore over the alerts identity columns (migration 010):
lookup by dedup_key (never LIKE), insert when a stream record arrives
with no row, per-channel state in alert_deliveries."""
from __future__ import annotations

import psycopg


class PgDeliveryStore:
    def __init__(self, dsn: str):
        self.conn = psycopg.connect(dsn, autocommit=False)

    def alert_id(self, rec) -> int:
        """Row for rec.dedup_key, inserting from the record when absent."""
        row = self.conn.execute(
            "SELECT id FROM alerts WHERE dedup_key = %s", (rec.dedup_key,)).fetchone()
        if row:
            return row[0]
        msg = rec.model_dump_json()
        row = self.conn.execute(
            "INSERT INTO alerts (dedup_key, source_engine, kind, chain_id, record, "
            "destination, message, delivery_state) "
            "VALUES (%s,%s,%s,%s,%s,'nexus:alerts',%s,'pending') "
            "ON CONFLICT (dedup_key) WHERE dedup_key IS NOT NULL DO NOTHING "
            "RETURNING id",
            (rec.dedup_key, rec.source_engine, rec.kind, rec.chain_id, msg, msg)).fetchone()
        if row:
            return row[0]
        return self.conn.execute(
            "SELECT id FROM alerts WHERE dedup_key = %s", (rec.dedup_key,)).fetchone()[0]

    def channel_state(self, alert_id: int, channel: str):
        row = self.conn.execute(
            "SELECT state FROM alert_deliveries WHERE alert_id=%s AND channel=%s",
            (alert_id, channel)).fetchone()
        return row[0] if row else None

    def set_channel_state(self, alert_id: int, channel: str, state: str,
                          attempts: int, error: str | None = None):
        self.conn.execute(
            "INSERT INTO alert_deliveries (alert_id, channel, state, attempts, last_error, updated_at) "
            "VALUES (%s,%s,%s,%s,%s,now()) "
            "ON CONFLICT (alert_id, channel) DO UPDATE "
            "SET state=%s, attempts=%s, last_error=%s, updated_at=now()",
            (alert_id, channel, state, attempts, error, state, attempts, error))

    def set_delivery_state(self, alert_id: int, state: str):
        self.conn.execute("UPDATE alerts SET delivery_state=%s WHERE id=%s", (state, alert_id))

    def commit(self):
        self.conn.commit()

    def close(self):
        self.conn.close()
