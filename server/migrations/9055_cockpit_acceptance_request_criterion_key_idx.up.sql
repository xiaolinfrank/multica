CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS cockpit_acceptance_request_criterion_key_idx ON cockpit_acceptance_request_criterion (workspace_id, request_id, criterion_id);
