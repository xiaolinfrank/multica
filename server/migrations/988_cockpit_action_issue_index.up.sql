CREATE INDEX CONCURRENTLY cockpit_action_issue_idx ON cockpit_meeting_action(workspace_id,issue_id,id DESC) WHERE issue_id IS NOT NULL;
