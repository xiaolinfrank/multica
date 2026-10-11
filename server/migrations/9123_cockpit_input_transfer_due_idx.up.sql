CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_cockpit_input_transfer_due ON cockpit_input_transfer (next_attempt_at,id) WHERE state IN ('queued','awaiting_bytes') AND workspace_deleted_at IS NULL;
