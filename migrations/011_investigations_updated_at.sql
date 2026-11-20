-- Engine 6 worker mode: updated_at for stale-claim requeue detection.
ALTER TABLE investigations ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT now();
