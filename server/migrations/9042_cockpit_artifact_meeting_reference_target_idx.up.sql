CREATE INDEX CONCURRENTLY IF NOT EXISTS cockpit_artifact_meeting_reference_target_idx ON cockpit_artifact_meeting_reference (workspace_id, meeting_id, id) WHERE removed_at IS NULL;
