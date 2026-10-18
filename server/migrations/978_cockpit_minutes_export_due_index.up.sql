CREATE INDEX CONCURRENTLY IF NOT EXISTS cockpit_minutes_export_due_idx ON cockpit_minutes_export (root_id, status, next_retry_at, lease_expires_at) WHERE status IN ('queued','running','retry_wait');
