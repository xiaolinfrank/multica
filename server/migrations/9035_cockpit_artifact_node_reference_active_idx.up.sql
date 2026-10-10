CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS cockpit_artifact_node_reference_active_idx ON cockpit_artifact_node_reference (workspace_id, node_id, version_id, purpose) WHERE removed_at IS NULL;
