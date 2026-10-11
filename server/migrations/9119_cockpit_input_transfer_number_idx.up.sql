CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS idx_cockpit_input_transfer_number ON cockpit_input_transfer (workspace_id,version_id,transfer_number);
