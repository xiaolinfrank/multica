CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS cockpit_artifact_handoff_command_idx ON cockpit_artifact_reviewer_handoff (workspace_id, artifact_id, command_key);
