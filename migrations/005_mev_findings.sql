-- Engine 5: MEV findings + incremental analyzer cursor
CREATE TABLE IF NOT EXISTS mev_findings (
  id BIGSERIAL PRIMARY KEY,
  chain_id INTEGER NOT NULL,
  block_number BIGINT NOT NULL,
  kind TEXT NOT NULL,
  initiator TEXT,
  victim TEXT,
  pool_id TEXT,
  evidence JSONB,
  estimated_impact JSONB,
  confidence JSONB,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE (kind, chain_id, block_number, initiator, pool_id)
);
CREATE TABLE IF NOT EXISTS mev_analyzer_cursor (
  chain_id INTEGER PRIMARY KEY,
  last_block BIGINT
);
