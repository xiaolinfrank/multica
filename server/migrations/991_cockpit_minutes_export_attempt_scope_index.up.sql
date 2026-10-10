CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS cockpit_minutes_export_attempt_scope_idx ON cockpit_minutes_export_attempt (workspace_id, export_id, attempt_number DESC);
