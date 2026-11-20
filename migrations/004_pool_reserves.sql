-- Engine 4: pool reserve snapshots + pool metadata columns
CREATE TABLE IF NOT EXISTS pool_reserves (
  pool_id TEXT NOT NULL,
  chain_id INTEGER NOT NULL,
  reserve0 NUMERIC,
  reserve1 NUMERIC,
  source TEXT,
  block_number BIGINT,
  ts TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (pool_id, block_number)
);
ALTER TABLE pools
  ADD COLUMN IF NOT EXISTS fee_tier INTEGER,
  ADD COLUMN IF NOT EXISTS created_block BIGINT,
  ADD COLUMN IF NOT EXISTS created_tx TEXT;
