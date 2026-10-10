CREATE INDEX CONCURRENTLY IF NOT EXISTS cockpit_artifact_source_issue_idx ON cockpit_artifact (workspace_id, source_issue_id, id);
