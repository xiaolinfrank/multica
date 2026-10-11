CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS idx_cockpit_input_creation ON cockpit_input (workspace_id,creation_key);
