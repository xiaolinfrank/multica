CREATE INDEX CONCURRENTLY IF NOT EXISTS cockpit_artifact_producer_assignment_to_idx ON cockpit_artifact_producer_assignment (workspace_id, to_issue_id, id);
