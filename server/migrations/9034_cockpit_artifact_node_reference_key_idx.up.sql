CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS cockpit_artifact_node_reference_key_idx ON cockpit_artifact_node_reference (workspace_id, reference_key);
