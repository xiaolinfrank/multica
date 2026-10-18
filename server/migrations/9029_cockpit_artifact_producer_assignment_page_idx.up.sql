CREATE INDEX CONCURRENTLY IF NOT EXISTS cockpit_artifact_producer_assignment_page_idx ON cockpit_artifact_producer_assignment (workspace_id, artifact_id, created_at, id);
