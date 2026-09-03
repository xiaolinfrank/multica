CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_cockpit_node_tree ON cockpit_node (cockpit_id, parent_id, position);
