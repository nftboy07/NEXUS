"""Engine 5 entrypoint. Analyzes stored data from mev_analyzer_cursor up to
Engine 1's checkpoint (minus MEV_CONFIRMATIONS) per chain, in chunks of at
most MEV_MAX_BLOCKS_PER_RUN, committing the cursor per chunk. Idempotent.

  python src/main.py                       # one batch pass (cron-friendly)
  python src/main.py --loop                # compose service: pass every MEV_INTERVAL_SECONDS
  python src/main.py --chain 1 --from-block N --to-block M
                                           # explicit range; cursor untouched
"""
from __future__ import annotations

import argparse
import json
import logging
import os
import signal
import sys
import time

import redis as redis_lib

from blocks import analyze_range
from findings import RunStats
from liquidations import load_protocols
from store import PgMevStore

_STD = set(logging.LogRecord("", 0, "", 0, "", (), None).__dict__)


def log() -> logging.Logger:
    class F(logging.Formatter):
        def format(self, r):
            return json.dumps({"ts": self.formatTime(r), "level": r.levelname.lower(),
                               "logger": "mev_analyzer", "msg": r.getMessage(),
                               **{k: v for k, v in r.__dict__.items() if k not in _STD}}, default=str)

    h = logging.StreamHandler(); h.setFormatter(F())
    lg = logging.getLogger("mev_analyzer"); lg.handlers = [h]
    lg.setLevel(os.getenv("LOG_LEVEL", "INFO").upper())
    return lg


def plan_chunks(cursor, head, batch, max_blocks):
    """[(from, to)] chunks to analyze; empty when nothing new."""
    start = (cursor + 1) if cursor is not None else max(head - batch + 1, 0)
    out = []
    while start <= head:
        end = min(head, start + max_blocks - 1)
        out.append((start, end))
        start = end + 1
    return out


def run_pass(store, xadd, protocols, cfg, lg, stats) -> None:
    for cid in cfg["chain_ids"]:
        try:
            cp = store.checkpoint(cid)
            if cp is None:
                lg.warning("no checkpoint for chain; skipping", extra={"chain_id": cid})
                continue
            head = int(cp) - cfg["confirmations"]
            for frm, to in plan_chunks(store.cursor(cid), head, cfg["batch"], cfg["max_blocks"]):
                n = analyze_range(store, cid, frm, to, protocols.get(cid, {}), cfg["min_impact"], stats, xadd, lg)
                store.set_cursor(cid, to)
                store.commit()
                lg.info("range analyzed", extra={"chain_id": cid, "from": frm, "to": to, "findings_written": n})
        except Exception as e:  # one chain failing must not stop the others
            store.rollback()
            lg.error("chain analysis failed", extra={"chain_id": cid, "err": repr(e)})


def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--loop", action="store_true")
    ap.add_argument("--chain", type=int)
    ap.add_argument("--from-block", type=int)
    ap.add_argument("--to-block", type=int)
    args = ap.parse_args(argv)

    lg = log()
    dsn = os.environ["DATABASE_URL"]
    xadd = None
    if os.getenv("REDIS_URL"):
        rc = redis_lib.from_url(os.environ["REDIS_URL"])
        xadd = lambda stream, fields: rc.xadd(stream, fields)  # noqa: E731
    protocols = load_protocols()
    cfg = {
        "chain_ids": [int(x) for x in os.getenv("MEV_CHAIN_IDS", "1,8453").split(",") if x.strip()],
        "min_impact": float(os.getenv("MEV_MIN_VICTIM_IMPACT_PCT", "0.5")),
        "batch": int(os.getenv("MEV_BATCH_BLOCKS", "500")),
        "max_blocks": int(os.getenv("MEV_MAX_BLOCKS_PER_RUN", "2000")),
        "confirmations": int(os.getenv("MEV_CONFIRMATIONS", "2")),
    }

    if args.from_block is not None or args.to_block is not None:
        if args.chain is None or args.from_block is None or args.to_block is None:
            ap.error("--chain, --from-block and --to-block go together")
        store = PgMevStore(dsn)
        stats = RunStats()
        n = analyze_range(store, args.chain, args.from_block, args.to_block,
                          protocols.get(args.chain, {}), cfg["min_impact"], stats, xadd, lg)
        store.commit(); store.close()
        lg.info("range analyzed", extra={"chain_id": args.chain, "from": args.from_block,
                                         "to": args.to_block, "findings_written": n})
        print(json.dumps(stats.summary()))
        return 0

    stopping = False

    def _stop(*_):
        nonlocal stopping
        stopping = True
    signal.signal(signal.SIGTERM, _stop)
    signal.signal(signal.SIGINT, _stop)

    interval = float(os.getenv("MEV_INTERVAL_SECONDS", "30"))
    while True:
        stats = RunStats()
        try:
            store = PgMevStore(dsn)
            try:
                run_pass(store, xadd, protocols, cfg, lg, stats)
            finally:
                store.close()
        except Exception as e:
            if not args.loop:
                raise
            lg.error("pass failed; retrying next interval", extra={"err": repr(e)})
        lg.info("pass complete", extra=stats.summary())
        if not args.loop:
            print(json.dumps(stats.summary()))
            return 0
        deadline = time.time() + interval
        while not stopping and time.time() < deadline:
            time.sleep(1)
        if stopping:
            return 0


if __name__ == "__main__":
    sys.exit(main())
