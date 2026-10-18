CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS idx_cockpit_input_manifest_head ON cockpit_issue_input_manifest (workspace_id,issue_id);
