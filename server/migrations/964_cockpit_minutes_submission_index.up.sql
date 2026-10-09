CREATE UNIQUE INDEX CONCURRENTLY cockpit_minutes_submission_idx ON cockpit_minutes_version (workspace_id, meeting_id, submission_key);
