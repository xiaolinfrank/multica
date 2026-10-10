CREATE INDEX CONCURRENTLY IF NOT EXISTS cockpit_acceptance_handoff_page_idx ON cockpit_acceptance_reviewer_handoff (workspace_id, node_id, created_at, id);
