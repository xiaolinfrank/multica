CREATE INDEX CONCURRENTLY IF NOT EXISTS cockpit_artifact_producer_issue_idx ON cockpit_artifact (workspace_id, authorized_producer_issue_id, id);
