CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS cockpit_artifact_capture_attempt_number_idx ON cockpit_artifact_capture_attempt (workspace_id, version_id, attempt_number);
