-- Engine 2: pending transaction lifecycle tracking
CREATE TABLE IF NOT EXISTS pending_transactions (
  chain_id INTEGER NOT NULL,
  hash TEXT NOT NULL,
  sender TEXT,
  nonce BIGINT,
  recipient TEXT,
  value NUMERIC,
  method TEXT,
  decoded JSONB,
  status TEXT NOT NULL,
  first_seen_at TIMESTAMPTZ DEFAULT now(),
  first_seen_block BIGINT,
  included_block BIGINT,
  replaced_by TEXT,
  updated_at TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (chain_id, hash)
);
CREATE INDEX IF NOT EXISTS pending_tx_sender_nonce ON pending_transactions (chain_id, sender, nonce);
CREATE INDEX IF NOT EXISTS pending_tx_status ON pending_transactions (status);
-- Inclusion/replacement/reorg checks need the included tx's nonce + block hash;
-- Engine 1 already populates transactions rows (columns added here, written by
-- evm_listener once this migration is applied).
ALTER TABLE transactions
  ADD COLUMN IF NOT EXISTS nonce BIGINT,
  ADD COLUMN IF NOT EXISTS block_hash TEXT;
