-- Engine 6: investigation report details on the existing table
ALTER TABLE investigations
  ADD COLUMN IF NOT EXISTS report JSONB,
  ADD COLUMN IF NOT EXISTS citations_valid BOOLEAN,
  ADD COLUMN IF NOT EXISTS input_tokens INTEGER,
  ADD COLUMN IF NOT EXISTS output_tokens INTEGER,
  ADD COLUMN IF NOT EXISTS cost_estimate NUMERIC,
  ADD COLUMN IF NOT EXISTS model TEXT,
  ADD COLUMN IF NOT EXISTS chain_id INTEGER,
  ADD COLUMN IF NOT EXISTS trigger_tx TEXT;
