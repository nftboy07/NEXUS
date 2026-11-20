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
    log.setLevel(os.getenv("LOG_LEVEL", "INFO"))
    log.handlers = [h]
    return log


def refresh_scores(store, chain_id: int, log: logging.Logger) -> int:
    """Recompute scores + hypotheses for all wallets with stored transfers."""
    rows = store.all_transfers(chain_id)
    if not rows:
        return 0
    # token -> sorted per-wallet first-inbound blocks (for early_discovery)
    first_inbound: dict[tuple[str, str], int] = {}
    for r in sorted(rows, key=lambda x: int(x["block_number"])):
        key = (r["token"], r["recipient"])
        first_inbound.setdefault(key, int(r["block_number"]))
    chain_first: dict[str, list[int]] = {}
    for (token, _), b in first_inbound.items():
        chain_first.setdefault(token, []).append(b)
    for lst in chain_first.values():
        lst.sort()

    wallets = {r["sender"] for r in rows} | {r["recipient"] for r in rows}
    n = 0
    for w in wallets:
        wrows = [r for r in rows if r["sender"] == w or r["recipient"] == w]
        s = compute_score(w, chain_id, wrows, chain_first, store.failed_tx_count(chain_id, w))
        store.upsert_score(w, chain_id, s.score, s.coverage, s.components.model_dump())
        n += 1
    for h in find_hypotheses(chain_id, rows):
        store.upsert_relation(
            h.address_a, h.address_b, chain_id,
            [s.model_dump() for s in h.signals], h.confidence, h.alternatives,
        )
    store.commit()
    return n


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
    last_refresh = 0.0
    last_heartbeat = 0.0
    processed = 0
    log.info("wallet_intelligence started", extra={"group": GROUP, "stream": EVENTS_STREAM})
    while not stop:
        processed += consumer.poll()
        now = time.time()
        if now - last_heartbeat >= 60:
            log.info("heartbeat", extra={"processed": processed})
            last_heartbeat = now
        if now - last_refresh >= refresh_secs:
            n = refresh_scores(store, 1, log)
            log.info("score refresh", extra={"wallets": n})
            last_refresh = now
    store.close()
    log.info("wallet_intelligence stopped")


if __name__ == "__main__":
    sys.exit(main())
