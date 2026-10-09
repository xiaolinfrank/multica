CREATE UNIQUE INDEX CONCURRENTLY cockpit_minutes_number_idx ON cockpit_minutes_version (workspace_id, meeting_id, version_number);
