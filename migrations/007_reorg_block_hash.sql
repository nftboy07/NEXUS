-- Reorg propagation (Wave 1 follow-up): downstream engines invalidate rows
-- derived from orphaned blocks. block_hash is nullable for rows written
-- before this column existed.
ALTER TABLE liquidity_events ADD COLUMN IF NOT EXISTS block_hash TEXT;
ALTER TABLE pool_reserves   ADD COLUMN IF NOT EXISTS block_hash TEXT;
ALTER TABLE wallet_transfers ADD COLUMN IF NOT EXISTS block_hash TEXT;
ALTER TABLE pools           ADD COLUMN IF NOT EXISTS block_hash TEXT;
CREATE INDEX IF NOT EXISTS liquidity_events_block_hash ON liquidity_events (chain_id, block_hash);
CREATE INDEX IF NOT EXISTS pool_reserves_block_hash   ON pool_reserves (chain_id, block_hash);
CREATE INDEX IF NOT EXISTS wallet_transfers_block_hash ON wallet_transfers (chain_id, block_hash);
-- Listener marker table: a block_removed event is published exactly once per
-- orphaned block, even if the reorg path is replayed.
CREATE TABLE IF NOT EXISTS removed_blocks (
  chain_id INTEGER NOT NULL,
  block_hash TEXT NOT NULL,
  removed_at TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (chain_id, block_hash)
);
