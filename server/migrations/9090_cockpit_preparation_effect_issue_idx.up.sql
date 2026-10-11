CREATE INDEX CONCURRENTLY cockpit_preparation_effect_issue_idx ON cockpit_meeting_preparation_effect (workspace_id,issue_id,id) WHERE issue_id IS NOT NULL;
