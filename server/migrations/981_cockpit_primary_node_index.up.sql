CREATE INDEX CONCURRENTLY IF NOT EXISTS cockpit_primary_node_idx ON cockpit_issue_primary (workspace_id,node_id,issue_id) WHERE node_id IS NOT NULL;
