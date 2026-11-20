"""CLI: manual trigger only.
  python src/main.py --chain 1 --tx 0x...
  python src/main.py --chain 1 --address 0x...   (investigates recent activity)
"""
from __future__ import annotations

import argparse
import json
import logging
import sys

import psycopg


def _log():
    class F(logging.Formatter):
        def format(self, r):
            return json.dumps({"ts": self.formatTime(r), "level": r.levelname.lower(),
                               "logger": "ai_investigator", "msg": r.getMessage()})
    lg = logging.getLogger("ai_investigator")
    h = logging.StreamHandler(); h.setFormatter(F()); lg.handlers = [h]; lg.setLevel("INFO")
    return lg


def main() -> int:
    ap = argparse.ArgumentParser(prog="ai_investigator")
    ap.add_argument("--chain", type=int, required=True)
    ap.add_argument("--tx")
    ap.add_argument("--address")
    ap.add_argument("--dsn", default=None)
    args = ap.parse_args()
    if not args.tx and not args.address:
        ap.error("one of --tx or --address is required")

    import os
    dsn = args.dsn or os.environ["DATABASE_URL"]
    conn = psycopg.connect(dsn)
    log = _log()

    from investigate import run_investigation

    if args.tx:
        inv_id = run_investigation(conn, args.chain, args.tx.lower(), log=log)
    else:
        # --address: investigate the wallet's most recent stored tx
        cur = conn.execute(
            "SELECT tx_hash FROM wallet_transfers WHERE chain_id=%s AND (sender=%s OR recipient=%s) "
            "ORDER BY block_number DESC LIMIT 1",
            (args.chain, args.address.lower(), args.address.lower()))
        row = cur.fetchone()
        if not row:
            log.warning("no stored activity for address", extra={"address": args.address})
            return 1
        inv_id = run_investigation(conn, args.chain, row[0], log=log)

    cur = conn.execute("SELECT status, citations_valid FROM investigations WHERE id=%s", (inv_id,))
    status, valid = cur.fetchone()
    print(json.dumps({"investigation_id": inv_id, "status": status, "citations_valid": valid}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
