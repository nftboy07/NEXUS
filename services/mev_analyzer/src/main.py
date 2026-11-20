"""Batch analyzer entrypoint: from mev_analyzer_cursor to Engine 1's
checkpoint per chain. Safe to run repeatedly (cron-friendly, idempotent)."""
from __future__ import annotations

import logging
import os
import sys

import redis as redis_lib

from blocks import analyze_block
from findings import RunStats
from liquidations import load_protocols
from store import PgMevStore


def log() -> logging.Logger:
    import json

    class F(logging.Formatter):
        def format(self, r):
            return json.dumps({"ts": self.formatTime(r), "level": r.levelname.lower(),
                               "logger": "mev_analyzer", "msg": r.getMessage()})

    h = logging.StreamHandler(); h.setFormatter(F())
    lg = logging.getLogger("mev_analyzer"); lg.handlers = [h]; lg.setLevel("INFO")
    return lg


def main() -> int:
    lg = log()
    dsn = os.environ["DATABASE_URL"]
    store = PgMevStore(dsn)
    r = None
    if os.getenv("REDIS_URL"):
        rc = redis_lib.from_url(os.environ["REDIS_URL"])
        r = lambda stream, fields: rc.xadd(stream, fields)  # noqa: E731
    protocols = load_protocols()
    chain_ids = [int(x) for x in os.getenv("MEV_CHAIN_IDS", "1,8453").split(",")]
    min_impact = float(os.getenv("MEV_MIN_VICTIM_IMPACT_PCT", "0.5"))
    batch = int(os.getenv("MEV_BATCH_BLOCKS", "500"))

    stats = RunStats()
    for cid in chain_ids:
        head = store.checkpoint(cid)
        if head is None:
            lg.warning("no checkpoint for chain; skipping", extra={"chain_id": cid})
            continue
        start = (store.cursor(cid) or max(head - batch, 0)) + 1
        addrs = protocols.get(cid, {})
        for block in range(int(start), int(head) + 1):
            analyze_block(store, cid, block, addrs, min_impact, stats, r, lg)
        store.set_cursor(cid, int(head))
        store.commit()
        lg.info("chain analyzed", extra={"chain_id": cid, "from": start, "to": int(head)})
    lg.info("run complete", extra=stats.summary())
    print(stats.summary())
    return 0


if __name__ == "__main__":
    sys.exit(main())
