"""Auto-trigger: enqueue investigations from Stage A alerts.

The producing engines (wallet_intelligence, dex_monitor, mev_analyzer) are
the deterministic Stage A selection — only events they alerted on reach
the AI. Each alert's tx hash (facts.tx_hash, or facts.evidence[0].tx_hash
for MEV) becomes one 'queued' investigations row. Idempotent: at most one
auto investigation per (chain_id, tx), enforced by a unique index
(migration 012) and a NOT EXISTS guard that also skips txs already
investigated manually. Bounded per call and per hour so a configured paid
model can never be flooded.
"""
from __future__ import annotations

import logging
import os
from typing import Optional

AUTO_ENV = "INVESTIGATOR_AUTO_TRIGGER"
KINDS_ENV = "INVESTIGATOR_AUTO_KINDS"
BATCH_ENV = "INVESTIGATOR_AUTO_BATCH"
HOURLY_ENV = "INVESTIGATOR_AUTO_MAX_PER_HOUR"

DEFAULT_KINDS = ("whale_transfer", "liquidity_removal", "potential_sandwich",
                 "cyclic_arbitrage", "liquidation", "gas_outlier")
DEFAULT_BATCH = 10
DEFAULT_HOURLY = 20

ENQUEUE_SQL = """
INSERT INTO investigations (trigger, chain_id, trigger_tx, status, source_alert_id)
SELECT DISTINCT ON (a.chain_id, x.tx)
       'alert:' || a.id || ':' || a.source_engine || ':' || a.kind,
       a.chain_id, x.tx, 'queued', a.id
FROM alerts a
CROSS JOIN LATERAL (
  SELECT lower(COALESCE(a.record->'facts'->>'tx_hash',
                        a.record->'facts'->'evidence'->0->>'tx_hash')) AS tx
) x
WHERE jsonb_typeof(a.record) = 'object'
  AND a.kind = ANY(%s)
  AND a.chain_id IS NOT NULL
  AND x.tx IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM investigations i
                  WHERE i.chain_id = a.chain_id AND i.trigger_tx = x.tx)
ORDER BY a.chain_id, x.tx, a.id
LIMIT %s
ON CONFLICT DO NOTHING
RETURNING id
"""


def auto_enabled() -> bool:
    return os.getenv(AUTO_ENV, "true").strip().lower() not in ("0", "false", "no", "off")


def _kinds() -> list[str]:
    raw = os.getenv(KINDS_ENV)
    if not raw:
        return list(DEFAULT_KINDS)
    return [k.strip() for k in raw.split(",") if k.strip()]


def enqueue_from_alerts(conn, log: Optional[logging.Logger] = None,
                        batch: Optional[int] = None,
                        max_per_hour: Optional[int] = None) -> list[int]:
    """Create 'queued' investigations for not-yet-investigated alert txs.
    Returns the new investigation ids."""
    log = log or logging.getLogger("ai_investigator")
    batch = batch if batch is not None else int(os.getenv(BATCH_ENV, DEFAULT_BATCH))
    max_per_hour = (max_per_hour if max_per_hour is not None
                    else int(os.getenv(HOURLY_ENV, DEFAULT_HOURLY)))
    recent = conn.execute(
        "SELECT COUNT(*) FROM investigations WHERE source_alert_id IS NOT NULL "
        "AND created_at > now() - interval '1 hour'").fetchone()[0]
    limit = min(batch, max_per_hour - int(recent))
    if limit <= 0:
        return []
    ids = [r[0] for r in conn.execute(ENQUEUE_SQL, (_kinds(), limit)).fetchall()]
    conn.commit()
    if ids:
        log.info("investigations enqueued from alerts", extra={"ids": ids})
    return ids
