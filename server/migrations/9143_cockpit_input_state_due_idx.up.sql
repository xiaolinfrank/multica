CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_cockpit_input_state_due ON cockpit_input_transfer(state,next_attempt_at,id) WHERE next_attempt_at IS NOT NULL AND workspace_deleted_at IS NULL;
