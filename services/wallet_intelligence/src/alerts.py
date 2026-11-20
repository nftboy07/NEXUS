"""Alert emission: alerts table row + nexus:alerts XADD, dedup_key'd so the
same event can never alert twice."""
from __future__ import annotations

import json
import logging
from typing import Protocol

from db import WalletStore
from models import AlertRecord

ALERTS_STREAM = "nexus:alerts"
ALERTS_DESTINATION = "nexus:alerts"


class Alerter(Protocol):
    def xadd(self, stream: str, fields: dict) -> object: ...


class AlertSink:
    def __init__(self, store: WalletStore, redis: Alerter, log: logging.Logger):
        self.store = store
        self.redis = redis
        self.log = log

    def emit(self, rec: AlertRecord) -> bool:
        """Write the alert once per dedup_key. Returns True when emitted."""
        message = rec.model_dump_json()
        if not self.store.insert_alert(rec, message):
            self.log.info("alert already emitted", extra={"dedup_key": rec.dedup_key})
            return False
        self.redis.xadd(
            ALERTS_STREAM,
            {
                "dedup_key": rec.dedup_key,
                "source_engine": rec.source_engine,
                "kind": rec.kind,
                "chain_id": str(rec.chain_id),
                "record": message,
            },
        )
        self.log.warning("alert emitted", extra={"kind": rec.kind, "dedup_key": rec.dedup_key})
        return True
