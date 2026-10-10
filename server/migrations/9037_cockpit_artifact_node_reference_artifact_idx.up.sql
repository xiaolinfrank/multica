CREATE INDEX CONCURRENTLY IF NOT EXISTS cockpit_artifact_node_reference_artifact_idx ON cockpit_artifact_node_reference (workspace_id, artifact_id, id);
