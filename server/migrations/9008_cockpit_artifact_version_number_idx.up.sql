CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS cockpit_artifact_version_number_idx ON cockpit_artifact_version (workspace_id, artifact_id, version_number);
