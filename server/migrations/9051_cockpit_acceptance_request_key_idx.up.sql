CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS cockpit_acceptance_request_key_idx ON cockpit_acceptance_request (workspace_id, node_id, request_key);
