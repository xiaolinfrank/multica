CREATE UNIQUE INDEX CONCURRENTLY cockpit_reviewer_handoff_key_idx ON cockpit_reviewer_handoff (workspace_id, meeting_id, handoff_key);
