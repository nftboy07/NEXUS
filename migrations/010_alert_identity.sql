-- Alert identity + per-channel delivery tracking.
-- Producers insert with dedup_key/source_engine/kind/chain_id/record;
-- dedup is enforced by the UNIQUE index, not LIKE scans. alert_deliveries
-- holds per-channel state so the dispatcher never re-sends a sent channel.
ALTER TABLE alerts
  ADD COLUMN IF NOT EXISTS dedup_key TEXT,
  ADD COLUMN IF NOT EXISTS source_engine TEXT,
  ADD COLUMN IF NOT EXISTS kind TEXT,
  ADD COLUMN IF NOT EXISTS chain_id INTEGER,
  ADD COLUMN IF NOT EXISTS record JSONB;
CREATE UNIQUE INDEX IF NOT EXISTS alerts_dedup_key_uq
  ON alerts(dedup_key) WHERE dedup_key IS NOT NULL;
CREATE TABLE IF NOT EXISTS alert_deliveries (
  alert_id BIGINT REFERENCES alerts(id),
  channel TEXT,
  state TEXT,
  attempts INT DEFAULT 0,
  last_error TEXT,
  updated_at TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (alert_id, channel)
);
