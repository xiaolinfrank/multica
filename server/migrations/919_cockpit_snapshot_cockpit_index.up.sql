CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_cockpit_snapshot_cockpit ON cockpit_snapshot (cockpit_id, created_at DESC);
