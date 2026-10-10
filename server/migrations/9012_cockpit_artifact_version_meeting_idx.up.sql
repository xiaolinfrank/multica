CREATE INDEX CONCURRENTLY IF NOT EXISTS cockpit_artifact_version_meeting_idx ON cockpit_artifact_version (workspace_id, source_meeting_id, id) WHERE source_meeting_id IS NOT NULL;
