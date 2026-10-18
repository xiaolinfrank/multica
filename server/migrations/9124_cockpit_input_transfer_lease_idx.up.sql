CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_cockpit_input_transfer_lease ON cockpit_input_transfer (lease_expires_at,id) WHERE lease_expires_at IS NOT NULL;
