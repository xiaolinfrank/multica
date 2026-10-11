CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_cockpit_input_version_verify_due ON cockpit_input_version (verification_due_at,id) WHERE capture_state='ready' AND verification_due_at IS NOT NULL;
