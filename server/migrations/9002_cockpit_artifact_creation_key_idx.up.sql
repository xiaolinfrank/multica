CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS cockpit_artifact_creation_key_idx ON cockpit_artifact (workspace_id, creation_key);
