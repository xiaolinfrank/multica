CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_cockpit_input_version_verify_lease ON cockpit_input_version (verification_lease_expires_at,id) WHERE verification_lease_expires_at IS NOT NULL;
