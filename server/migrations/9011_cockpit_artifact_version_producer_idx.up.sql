CREATE INDEX CONCURRENTLY IF NOT EXISTS cockpit_artifact_version_producer_idx ON cockpit_artifact_version (workspace_id, producer_issue_id, id);
