-- Engine 6 auto-trigger: investigations enqueued from Stage A alerts.
-- source_alert_id links an auto-created investigation to the alert that
-- selected it; one auto investigation per (chain_id, trigger_tx).
ALTER TABLE investigations ADD COLUMN IF NOT EXISTS source_alert_id BIGINT;
CREATE UNIQUE INDEX IF NOT EXISTS investigations_auto_trigger_uq
  ON investigations (chain_id, trigger_tx) WHERE source_alert_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS investigations_status_idx ON investigations (status);
