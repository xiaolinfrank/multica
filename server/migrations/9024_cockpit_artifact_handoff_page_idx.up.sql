CREATE INDEX CONCURRENTLY IF NOT EXISTS cockpit_artifact_handoff_page_idx ON cockpit_artifact_reviewer_handoff (workspace_id, artifact_id, created_at, id);
