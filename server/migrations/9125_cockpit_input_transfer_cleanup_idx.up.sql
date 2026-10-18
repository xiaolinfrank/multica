CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_cockpit_input_transfer_cleanup ON cockpit_input_transfer (cleanup_due_at,id) WHERE cleanup_state IN ('pending','running','retry_wait');
