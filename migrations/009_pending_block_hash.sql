-- Engine 2 fix: pending txs mined without an Engine-1 transactions row are
-- resolved via eth_getTransactionReceipt; keep the including block hash on
-- the pending row so the REORGED check works without Engine 1's row.
ALTER TABLE pending_transactions ADD COLUMN IF NOT EXISTS included_block_hash TEXT;
