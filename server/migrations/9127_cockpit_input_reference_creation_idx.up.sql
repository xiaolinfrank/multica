CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS idx_cockpit_input_reference_creation ON cockpit_input_reference (workspace_id,creation_key);
