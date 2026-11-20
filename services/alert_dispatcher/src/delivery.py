"""Per-channel delivery state machine: alert_deliveries rows are
pending -> sent | failed | skipped_no_config. Bounded retries (3) on
transport errors only. Dedup by (alert_id, channel) — a channel already
`sent` is never re-sent, even if a sibling channel failed and the alert
is redelivered."""
from __future__ import annotations

import logging
import time
from typing import Optional, Protocol

from models import AlertRecord


class DeliveryStore(Protocol):
    def alert_id(self, rec: AlertRecord) -> int: ...
    def channel_state(self, alert_id: int, channel: str) -> Optional[str]: ...
    def set_channel_state(self, alert_id: int, channel: str, state: str,
                          attempts: int, error: str | None = None) -> None: ...
    def set_delivery_state(self, alert_id: int, state: str) -> None: ...
    def commit(self) -> None: ...


class Channel(Protocol):
    name: str

    def send(self, message: str, record: AlertRecord) -> str:
        """Returns 'sent' or 'skipped_no_config'; raises on transport error."""
        ...


def deliver(rec: AlertRecord, message: str, store: DeliveryStore,
            channels: list[Channel], log: logging.Logger,
            max_retries: int = 3) -> str:
    """Deliver to every channel not already `sent`. Aggregate row state:
    'failed' if any channel exhausted retries; 'skipped_no_config' only
    when every channel was skipped; else 'sent'."""
    aid = store.alert_id(rec)
    states = []
    for ch in channels:
        if store.channel_state(aid, ch.name) == "sent":
            states.append("sent")
            continue
        attempts = 0
        while True:
            try:
                state = ch.send(message, rec)
                attempts += 1
                break
            except Exception as e:  # transport errors only
                attempts += 1
                if attempts >= max_retries:
                    state = "failed"
                    log.error("channel delivery failed", extra={
                        "channel": ch.name, "dedup_key": rec.dedup_key, "err": str(e)})
                    break
                time.sleep(0.2 * (2 ** (attempts - 1)))
        states.append(state)
        store.set_channel_state(aid, ch.name, state, attempts,
                                None if state != "failed" else "retry limit reached")
    if "failed" in states:
        outcome = "failed"
    elif states and all(s == "skipped_no_config" for s in states):
        outcome = "skipped_no_config"
    else:
        outcome = "sent"
    store.set_delivery_state(aid, outcome)
    store.commit()
    return outcome
