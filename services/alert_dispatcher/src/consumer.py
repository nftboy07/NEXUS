"""Redis consumer group on nexus:alerts. Each record is validated against
alert.schema.json semantics via pydantic; invalid records are logged and
parked (acked, never crash the loop). Ack only after delivery completes."""
from __future__ import annotations

import json
import logging
from typing import Optional

from delivery import Channel, DeliveryStore, deliver
from format import format_alert
from models import AlertRecord

STREAM = "nexus:alerts"
GROUP = "alert_dispatcher"


def process_record(fields: dict, store: DeliveryStore, channels: list[Channel],
                   log: logging.Logger) -> bool:
    """Validate + format + deliver one stream record's 'record' field."""
    raw = fields.get("record") or fields.get(b"record")
    if raw is None:
        log.error("alert record missing 'record' field; parked")
        return False
    if isinstance(raw, bytes):
        raw = raw.decode()
    try:
        rec = AlertRecord.model_validate(json.loads(raw))
    except Exception as e:
        log.error("invalid alert record; parked", extra={"err": str(e)})
        return False
    return deliver(rec, format_alert(rec), store, channels, log) in ("sent", "skipped_no_config")


class Dispatcher:
    def __init__(self, redis, store: DeliveryStore, channels: list[Channel],
                 consumer: str = "dispatcher-1", log: Optional[logging.Logger] = None):
        self.redis = redis
        self.store = store
        self.channels = channels
        self.consumer = consumer
        self.log = log or logging.getLogger("alert_dispatcher")

    def ensure_group(self):
        try:
            self.redis.xgroup_create(STREAM, GROUP, id="0", mkstream=True)
        except Exception as e:
            if "BUSYGROUP" not in str(e):
                raise

    def poll(self, count: int = 50, block_ms: int = 2000) -> int:
        resp = self.redis.xreadgroup(GROUP, self.consumer, {STREAM: ">"}, count, block_ms) or []
        n = 0
        for _, msgs in resp:
            for msg_id, fields in msgs:
                mid = msg_id.decode() if isinstance(msg_id, bytes) else msg_id
                try:
                    process_record(fields, self.store, self.channels, self.log)
                finally:
                    # invalid records are parked (logged); delivery failures
                    # are marked 'failed' in the row — either way, ack.
                    self.redis.xack(STREAM, GROUP, mid)
                n += 1
        return n
