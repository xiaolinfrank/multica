CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_cockpit_input_page ON cockpit_input (workspace_id,created_at DESC,id);
