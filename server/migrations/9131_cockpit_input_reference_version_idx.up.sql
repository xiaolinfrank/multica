CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_cockpit_input_reference_version ON cockpit_input_reference (workspace_id,input_version_id,id);
