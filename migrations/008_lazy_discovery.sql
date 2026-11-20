-- Engine 4 lazy pool discovery: pools registered by probing their
-- factory() at runtime rather than observing PoolCreated.
ALTER TABLE pools ADD COLUMN IF NOT EXISTS discovery TEXT DEFAULT 'pool_created';
