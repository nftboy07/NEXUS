-- Engine 3: wallet intelligence scores + related-wallet hypotheses
CREATE TABLE IF NOT EXISTS wallet_scores (
  address TEXT NOT NULL,
  chain_id INTEGER NOT NULL,
  score NUMERIC,
  coverage JSONB,
  components JSONB,
  computed_at TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (address, chain_id)
);
CREATE TABLE IF NOT EXISTS wallet_relations (
  address_a TEXT NOT NULL,
  address_b TEXT NOT NULL,
  chain_id INTEGER NOT NULL,
  signals JSONB,
  confidence TEXT,
  alternatives JSONB,
  created_at TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (address_a, address_b, chain_id)
);
-- idempotent transfer inserts (services/wallet_intelligence/src/transfers.py)
CREATE UNIQUE INDEX IF NOT EXISTS wallet_transfers_dedup
  ON wallet_transfers (chain_id, tx_hash, token, sender, recipient, amount);
