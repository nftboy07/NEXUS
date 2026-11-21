"""Engine 3 entrypoint: redis consumer loop + periodic profile/score refresh.

Env: REDIS_URL, DATABASE_URL, WHALE_THRESHOLD_ETH (default 100),
CONSUMER_NAME, ACCUMULATION_WINDOW_DAYS (default 7), SCORE_REFRESH_SECONDS
(default 300), LOG_LEVEL.
"""
from __future__ import annotations

import logging
import os
import signal
import sys
import time

import redis

from alerts import AlertSink
from consumer import Consumer, EVENTS_STREAM, GROUP
from db import PgWalletStore
from scoring import compute_score
from clusters import find_hypotheses

EMPTY_RETRY_SECONDS = 30


def json_logger(name: str) -> logging.Logger:
    import json

    class F(logging.Formatter):
        def format(self, record):
            return json.dumps({
                "ts": self.formatTime(record),
                "level": record.levelname.lower(),
                "logger": record.name,
                "msg": record.getMessage(),
                **{k: v for k, v in record.__dict__.items()
                   if k not in logging.LogRecord("", 0, "", 0, "", (), None).__dict__},
            })

    h = logging.StreamHandler()
    h.setFormatter(F())
    log = logging.getLogger(name)
    log.setLevel(os.getenv("LOG_LEVEL", "INFO").upper())
    log.handlers = [h]
    return log


def refresh_scores(store, chain_id: int, log: logging.Logger) -> int:
    """Recompute scores + hypotheses for all wallets with stored transfers on
    one chain. One pass over rows (O(rows), not O(wallets x rows)); scores are
    committed before hypotheses so a slow/failed relation pass never discards
    them."""
    t0 = time.monotonic()
    rows = store.all_transfers(chain_id)
    if not rows:
        return 0
    # token -> sorted per-wallet first-inbound blocks (for early_discovery)
    first_inbound: dict[tuple[str, str], int] = {}
    by_wallet: dict[str, list[dict]] = {}
    for r in sorted(rows, key=lambda x: int(x["block_number"])):
        key = (r["token"], r["recipient"])
        first_inbound.setdefault(key, int(r["block_number"]))
        by_wallet.setdefault(r["sender"], []).append(r)
        if r["recipient"] != r["sender"]:
            by_wallet.setdefault(r["recipient"], []).append(r)
    chain_first: dict[str, list[int]] = {}
    for (token, _), b in first_inbound.items():
        chain_first.setdefault(token, []).append(b)
    for lst in chain_first.values():
        lst.sort()

    failed = store.failed_tx_counts(chain_id)
    scored = 0
    for w in sorted(by_wallet):
        s = compute_score(w, chain_id, by_wallet[w], chain_first, failed.get(w))
        store.upsert_score(w, chain_id, s.score, s.coverage, s.components.model_dump())
        if s.score is not None:
            scored += 1
    scores_pruned = store.prune_scores(chain_id, list(by_wallet))
    store.commit()
    t1 = time.monotonic()

    stats: dict = {}
    hyps = find_hypotheses(chain_id, rows, stats)
    for h in hyps:
        store.upsert_relation(
            h.address_a, h.address_b, chain_id,
            [s.model_dump() for s in h.signals], h.confidence, h.alternatives,
        )
    relations_pruned = store.prune_relations(chain_id, [(h.address_a, h.address_b) for h in hyps])
    store.commit()
    log.info("score refresh", extra={
        "chain_id": chain_id, "transfers": len(rows), "wallets": len(by_wallet),
        "wallets_with_score": scored, "relations": len(hyps), **stats,
        "scores_pruned": scores_pruned, "relations_pruned": relations_pruned,
        "score_secs": round(t1 - t0, 3), "relation_secs": round(time.monotonic() - t1, 3),
    })
    return len(by_wallet)


def refresh_all(store, log: logging.Logger) -> int:
    """Refresh every chain present in wallet_transfers. A failing chain is
    logged and rolled back; it never stops the consumer loop."""
    total = 0
    for chain_id in store.transfer_chain_ids():
        try:
            total += refresh_scores(store, chain_id, log)
        except Exception:
            store.rollback()
            log.exception("score refresh failed", extra={"chain_id": chain_id})
    return total


def next_refresh_delay(scored: int, now: float, warmup_until: float, refresh_secs: int) -> float:
    """Short retry while nothing is scored or during startup warm-up, so a
    chain whose first transfers arrive after the first refresh is scored
    within EMPTY_RETRY_SECONDS instead of a full interval."""
    if not scored or now < warmup_until:
        return min(refresh_secs, EMPTY_RETRY_SECONDS)
    return refresh_secs


def main() -> None:
    log = json_logger("wallet_intelligence")
    r = redis.from_url(os.environ["REDIS_URL"], decode_responses=False)
    store = PgWalletStore(os.environ["DATABASE_URL"])
    sink = AlertSink(store, r, log)
    consumer = Consumer(
        redis=r,
        store=store,
        sink=sink,
        consumer_name=os.getenv("CONSUMER_NAME", "wallet-intel-1"),
        whale_threshold_eth=float(os.getenv("WHALE_THRESHOLD_ETH", "100")),
        log=log,
    )
    consumer.ensure_group()
    recovered = consumer.recover()
    if recovered:
        log.info("recovered pending events", extra={"count": recovered})

    stop = False
    def _sig(*_):
        nonlocal stop
        stop = True
    signal.signal(signal.SIGTERM, _sig)
    signal.signal(signal.SIGINT, _sig)

    refresh_secs = int(os.getenv("SCORE_REFRESH_SECONDS", "300"))
    next_refresh = 0.0
    warmup_until = time.time() + refresh_secs
    last_heartbeat = 0.0
    processed = 0
    log.info("wallet_intelligence started", extra={"group": GROUP, "stream": EVENTS_STREAM})
    while not stop:
        processed += consumer.poll()
        now = time.time()
        if now - last_heartbeat >= 60:
            log.info("heartbeat", extra={"processed": processed})
            last_heartbeat = now
        if now >= next_refresh:
            n = refresh_all(store, log)
            next_refresh = now + next_refresh_delay(n, now, warmup_until, refresh_secs)
    store.close()
    log.info("wallet_intelligence stopped")


if __name__ == "__main__":
    sys.exit(main())
