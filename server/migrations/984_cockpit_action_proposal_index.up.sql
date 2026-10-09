CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS cockpit_action_proposal_idx ON cockpit_meeting_action (workspace_id,meeting_id,version_id,proposal_key);
