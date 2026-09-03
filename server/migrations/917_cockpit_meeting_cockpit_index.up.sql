CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_cockpit_meeting_cockpit ON cockpit_meeting (cockpit_id, meet_date DESC);
