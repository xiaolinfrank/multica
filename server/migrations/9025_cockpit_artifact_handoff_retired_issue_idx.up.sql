CREATE INDEX CONCURRENTLY IF NOT EXISTS cockpit_artifact_handoff_retired_issue_idx ON cockpit_artifact_reviewer_handoff (workspace_id, from_review_issue_id) WHERE from_review_issue_id IS NOT NULL;
