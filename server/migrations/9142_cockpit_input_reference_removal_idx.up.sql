CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS cockpit_input_reference_removal_idx ON cockpit_input_reference(workspace_id,meeting_id,removal_key) WHERE removal_key IS NOT NULL;
