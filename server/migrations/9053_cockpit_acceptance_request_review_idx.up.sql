CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS cockpit_acceptance_request_review_idx ON cockpit_acceptance_request (workspace_id, review_issue_id);
