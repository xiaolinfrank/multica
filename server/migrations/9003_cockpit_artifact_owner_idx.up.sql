CREATE INDEX CONCURRENTLY IF NOT EXISTS cockpit_artifact_owner_idx ON cockpit_artifact (workspace_id, owner_node_id, id);
