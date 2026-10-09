CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS cockpit_minutes_export_destination_idx ON cockpit_minutes_export (workspace_id, version_id, root_id, relative_path);
