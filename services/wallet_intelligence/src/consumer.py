"""Redis consumer group + per-event processing pipeline.

consume() reads nexus:events via XREADGROUP, decodes transfers, persists
them, runs whale checks, and acks only after a successful DB commit. On
shutdown, pending unacked entries are claimed back and retried (up to
max_retries, then parked on the wallet_intelligence_deadletter list).
"""
from __future__ import annotations

import json
import logging
from typing import Callable, Optional, Protocol

from alerts import AlertSink
from db import WalletStore
from models import AlertRecord, NormalizedEvent
from transfers import decode_transfer, persist_transfer
from whale import check_transfer

EVENTS_STREAM = "nexus:events"
GROUP = "wallet_intelligence"
DEADLETTER_LIST = "wallet_intelligence_deadletter"


class RedisStream(Protocol):
    def xgroup_create(self, stream: str, group: str, id: str, mkstream: bool) -> object: ...
    def xreadgroup(self, group: str, consumer: str, streams: dict, count: int, block: int) -> object: ...
    def xack(self, stream: str, group: str, *ids: str) -> object: ...
    def xautoclaim(self, stream: str, group: str, consumer: str, min_idle_time: int, start: str) -> object: ...
    def rpush(self, key: str, *values: str) -> object: ...
    def xadd(self, stream: str, fields: dict) -> object: ...


def process_event(
    ev: NormalizedEvent,
    store: WalletStore,
    sink: AlertSink,
    whale_threshold_eth: float,
    log: logging.Logger,
) -> bool:
    """One event: decode -> persist -> whale check -> commit. False = not a transfer."""
    if ev.kind == "block_removed":
        # Reorg propagation: drop derived rows for the orphaned block and
        # record an invalidation alert referencing what was withdrawn.
        block_hash = ev.payload.get("block_hash") or ev.block_hash
        if block_hash:
            deleted = store.delete_transfers_by_block(ev.chain_id, block_hash)
            prior = [k for k in store.alert_keys_referencing(block_hash)
                     if "reorg_invalidation" not in k]
            if prior:
                sink.emit(AlertRecord(
                    kind="reorg_invalidation",
                    chain_id=ev.chain_id,
                    title=f"Alerts invalidated by reorg of block {block_hash[:18]}…",
                    facts={
                        "invalidated_alerts": prior,
                        "reason": "source block orphaned by reorg",
                        "block_hash": block_hash,
                    },
                    dedup_key=f"wallet_intelligence:reorg_invalidation:{block_hash}",
                ))
            store.commit()
            log.warning("reorg invalidation applied",
                        extra={"block_hash": block_hash, "transfers_deleted": deleted})
        return True
    t = decode_transfer(ev)
    if t is None:
        return False
    if not persist_transfer(store, t, log):
        store.commit()
        return True
    alert = check_transfer(t, store.get_watchlists(), whale_threshold_eth)
    if alert:
        sink.emit(alert)
    store.commit()
    log.info(
        "transfer processed",
        extra={"dedup_key": t.dedup_key, "token": t.token, "amount": t.amount},
    )
    return True


class Consumer:
    def __init__(
        self,
        redis: RedisStream,
        store: WalletStore,
        sink: AlertSink,
        consumer_name: str = "wallet-intel-1",
        whale_threshold_eth: float = 100.0,
        max_retries: int = 3,
        log: Optional[logging.Logger] = None,
    ):
        self.redis = redis
        self.store = store
        self.sink = sink
        self.name = consumer_name
        self.whale_threshold_eth = whale_threshold_eth
        self.max_retries = max_retries
        self.log = log or logging.getLogger("wallet_intelligence.consumer")
        self.attempts: dict[str, int] = {}

    def ensure_group(self) -> None:
        try:
            self.redis.xgroup_create(EVENTS_STREAM, GROUP, id="0", mkstream=True)
        except Exception as e:
            if "BUSYGROUP" not in str(e):
                raise

    def _parse(self, raw) -> Optional[NormalizedEvent]:
        fields = raw[1] if isinstance(raw, tuple) else raw
        fields = {k.decode() if isinstance(k, bytes) else k: v for k, v in fields.items()}
        if "event" in fields:
            return NormalizedEvent.model_validate(json.loads(fields["event"]))
        return NormalizedEvent.model_validate(fields)

    def _handle(self, msg_id: str, ev: NormalizedEvent) -> None:
        try:
            process_event(ev, self.store, self.sink, self.whale_threshold_eth, self.log)
            self.redis.xack(EVENTS_STREAM, GROUP, msg_id)
            self.attempts.pop(msg_id, None)
        except Exception:
            self.attempts[msg_id] = self.attempts.get(msg_id, 0) + 1
            if self.attempts[msg_id] >= self.max_retries:
                self.log.error("event parked in deadletter", extra={"id": msg_id})
                self.redis.rpush(DEADLETTER_LIST, msg_id)
                self.redis.xack(EVENTS_STREAM, GROUP, msg_id)
            else:
                self.log.exception("event processing failed; left pending", extra={"id": msg_id})
            raise

    def poll(self, count: int = 100, block_ms: int = 2000) -> int:
        """One XREADGROUP pass. Returns messages handled."""
        resp = self.redis.xreadgroup(GROUP, self.name, {EVENTS_STREAM: ">"}, count, block_ms) or []
        n = 0
        for _, messages in resp:
            for msg in messages:
                ev = self._parse(msg)
                if ev is None:
                    continue
                try:
                    self._handle(msg[0].decode() if isinstance(msg[0], bytes) else msg[0], ev)
                except Exception:
                    pass
                n += 1
        return n

    def recover(self, min_idle_ms: int = 60_000) -> int:
        """Reclaim this group's stale pending entries (post-restart) and
        reprocess them; entries at max_retries go to the deadletter list."""
        resp = self.redis.xautoclaim(EVENTS_STREAM, GROUP, self.name, min_idle_ms, "0-0")
        msgs = resp[1] if isinstance(resp, (list, tuple)) else []
        n = 0
        for msg in msgs or []:
            ev = self._parse(msg)
            if ev is None:
                continue
            msg_id = msg[0].decode() if isinstance(msg[0], bytes) else msg[0]
            try:
                self._handle(msg_id, ev)
            except Exception:
                pass
            n += 1
        return n
