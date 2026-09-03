CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS idx_cockpit_node_issue_unique ON cockpit_node_issue (node_id, issue_id);
