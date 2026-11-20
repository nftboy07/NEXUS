"""DeliveryStore: alerts table delivery state keyed by dedup_key. The
dispatcher updates the row the producer engine inserted (matched by
dedup_key substring in message) or inserts one when absent."""
from __future__ import annotations

import psycopg


class PgDeliveryStore:
    def __init__(self, dsn: str):
        self.conn = psycopg.connect(dsn, autocommit=False)

    def delivery_state(self, dedup_key: str):
        cur = self.conn.execute(
            "SELECT delivery_state FROM alerts WHERE message LIKE %s "
            "ORDER BY id DESC LIMIT 1", (f"%{dedup_key}%",))
        row = cur.fetchone()
        return row[0] if row else None

    def set_delivery_state(self, dedup_key: str, state: str, error: str | None = None):
        self.conn.execute(
            "UPDATE alerts SET delivery_state=%s WHERE id = ("
            "  SELECT id FROM alerts WHERE message LIKE %s ORDER BY id DESC LIMIT 1)",
            (state, f"%{dedup_key}%"))

    def commit(self):
        self.conn.commit()

    def close(self):
        self.conn.close()
