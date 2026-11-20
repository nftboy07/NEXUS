"""Delivery state machine on the alerts table:
pending -> sent | failed | skipped_no_config. Bounded retries (3,
exponential backoff) on transport errors only. Dedup by dedup_key — a
record already `sent` is acked without redelivery."""
from __future__ import annotations

import logging
import time
from typing import Optional, Protocol

from models import AlertRecord


class DeliveryStore(Protocol):
    def delivery_state(self, dedup_key: str) -> Optional[str]: ...
    def set_delivery_state(self, dedup_key: str, state: str, error: str | None = None) -> None: ...
    def commit(self) -> None: ...


class Channel(Protocol):
    name: str

    def send(self, message: str, record: AlertRecord) -> str:
        """Returns 'sent' or 'skipped_no_config'; raises on transport error."""
        ...


def deliver(rec: AlertRecord, message: str, store: DeliveryStore,
            channels: list[Channel], log: logging.Logger,
            max_retries: int = 3) -> str:
    """Deliver to all channels. One channel's failure never blocks others.
    Aggregate: 'failed' if any channel exhausted retries; 'skipped_no_config'
    only when every channel was unconfigured; else 'sent'."""
    if store.delivery_state(rec.dedup_key) == "sent":
        log.info("alert already delivered", extra={"dedup_key": rec.dedup_key})
        return "sent"
    states = []
    for ch in channels:
        attempts = 0
        while True:
            try:
                states.append(ch.send(message, rec))
                break
            except Exception as e:  # transport errors only
                attempts += 1
                if attempts >= max_retries:
                    states.append("failed")
                    log.error("channel delivery failed", extra={
                        "channel": ch.name, "dedup_key": rec.dedup_key, "err": str(e)})
                    break
                time.sleep(0.2 * (2 ** (attempts - 1)))
    if "failed" in states:
        outcome = "failed"
    elif states and all(s == "skipped_no_config" for s in states):
        outcome = "skipped_no_config"
    else:
        outcome = "sent"
    store.set_delivery_state(rec.dedup_key, outcome)
    store.commit()
    return outcome
