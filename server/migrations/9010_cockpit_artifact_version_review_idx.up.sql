CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS cockpit_artifact_version_review_idx ON cockpit_artifact_version (workspace_id, review_issue_id) WHERE review_issue_id IS NOT NULL;
