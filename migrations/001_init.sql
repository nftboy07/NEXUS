-- NEXUS initial schema (docs/database.md)
CREATE TABLE IF NOT EXISTS chains (id INTEGER PRIMARY KEY, name TEXT NOT NULL, rpc_ref TEXT);
CREATE TABLE IF NOT EXISTS blocks (chain_id INTEGER NOT NULL, number BIGINT NOT NULL, hash TEXT NOT NULL, parent_hash TEXT, ts TIMESTAMPTZ, PRIMARY KEY (chain_id, hash));
CREATE TABLE IF NOT EXISTS transactions (chain_id INTEGER NOT NULL, hash TEXT NOT NULL, sender TEXT, recipient TEXT, value NUMERIC, status TEXT, block_number BIGINT, PRIMARY KEY (chain_id, hash));
CREATE TABLE IF NOT EXISTS logs (chain_id INTEGER NOT NULL, block_hash TEXT NOT NULL, transaction_hash TEXT NOT NULL, log_index INTEGER NOT NULL, contract TEXT, topics JSONB, data TEXT, removed BOOLEAN DEFAULT FALSE, PRIMARY KEY (chain_id, block_hash, transaction_hash, log_index));
CREATE TABLE IF NOT EXISTS wallets (address TEXT PRIMARY KEY, label TEXT, label_source TEXT, first_seen TIMESTAMPTZ);
CREATE TABLE IF NOT EXISTS wallet_transfers (id BIGSERIAL PRIMARY KEY, chain_id INTEGER, token TEXT, sender TEXT, recipient TEXT, amount NUMERIC, tx_hash TEXT, block_number BIGINT, ts TIMESTAMPTZ);
CREATE TABLE IF NOT EXISTS tokens (contract TEXT PRIMARY KEY, symbol TEXT, decimals INTEGER, metadata_source TEXT);
CREATE TABLE IF NOT EXISTS pools (id TEXT PRIMARY KEY, dex TEXT, token0 TEXT, token1 TEXT, chain_id INTEGER);
CREATE TABLE IF NOT EXISTS liquidity_events (id BIGSERIAL PRIMARY KEY, pool_id TEXT, event_type TEXT, amount0 NUMERIC, amount1 NUMERIC, tx_hash TEXT, block_number BIGINT, ts TIMESTAMPTZ);
CREATE TABLE IF NOT EXISTS watchlists (id BIGSERIAL PRIMARY KEY, kind TEXT, value TEXT, note TEXT);
CREATE TABLE IF NOT EXISTS investigations (id BIGSERIAL PRIMARY KEY, trigger TEXT, evidence JSONB, findings TEXT, confidence TEXT, status TEXT, created_at TIMESTAMPTZ DEFAULT now());
CREATE TABLE IF NOT EXISTS alerts (id BIGSERIAL PRIMARY KEY, destination TEXT, message TEXT, delivery_state TEXT, created_at TIMESTAMPTZ DEFAULT now());
CREATE TABLE IF NOT EXISTS checkpoints (chain_id INTEGER PRIMARY KEY, last_block BIGINT, last_log_cursor TEXT, updated_at TIMESTAMPTZ DEFAULT now());
CREATE TABLE IF NOT EXISTS provider_health (id BIGSERIAL PRIMARY KEY, provider TEXT, chain_id INTEGER, latency_ms INTEGER, errors INTEGER, ts TIMESTAMPTZ DEFAULT now());
