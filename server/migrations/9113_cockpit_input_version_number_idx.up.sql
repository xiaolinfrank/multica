CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS idx_cockpit_input_version_number ON cockpit_input_version (workspace_id,input_id,version_number);
