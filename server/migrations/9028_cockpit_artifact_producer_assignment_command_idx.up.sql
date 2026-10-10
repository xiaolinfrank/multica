CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS cockpit_artifact_producer_assignment_command_idx ON cockpit_artifact_producer_assignment (workspace_id, artifact_id, command_key);
