CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS cockpit_artifact_version_submission_idx ON cockpit_artifact_version (workspace_id, artifact_id, submission_key);
