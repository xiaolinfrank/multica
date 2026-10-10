CREATE INDEX CONCURRENTLY IF NOT EXISTS cockpit_artifact_capture_due_idx ON cockpit_artifact_capture (next_attempt_at, version_id) WHERE status IN ('queued','running','retry_wait');
