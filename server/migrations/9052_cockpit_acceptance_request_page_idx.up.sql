CREATE INDEX CONCURRENTLY IF NOT EXISTS cockpit_acceptance_request_page_idx ON cockpit_acceptance_request (workspace_id, node_id, created_at, id);
