CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS cockpit_acceptance_handoff_command_idx ON cockpit_acceptance_reviewer_handoff (workspace_id, node_id, command_key);
