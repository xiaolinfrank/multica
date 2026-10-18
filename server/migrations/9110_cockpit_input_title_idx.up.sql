CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_cockpit_input_title ON cockpit_input (workspace_id,lower(title) text_pattern_ops,id);
