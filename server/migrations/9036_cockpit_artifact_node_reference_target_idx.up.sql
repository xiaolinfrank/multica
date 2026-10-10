CREATE INDEX CONCURRENTLY IF NOT EXISTS cockpit_artifact_node_reference_target_idx ON cockpit_artifact_node_reference (workspace_id, node_id, id) WHERE removed_at IS NULL;
