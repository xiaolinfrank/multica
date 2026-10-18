CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS idx_cockpit_input_transfer_command ON cockpit_input_transfer (workspace_id,command_key);
