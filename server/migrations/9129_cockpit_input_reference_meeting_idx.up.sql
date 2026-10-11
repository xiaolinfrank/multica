CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_cockpit_input_reference_meeting ON cockpit_input_reference (workspace_id,meeting_id,created_at DESC,id);
