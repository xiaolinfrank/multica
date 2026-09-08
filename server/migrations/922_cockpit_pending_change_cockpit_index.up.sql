-- Queue reads filter by cockpit and sort newest first; the open-proposal
-- lookup is already served by the partial unique index.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_cockpit_pending_change_cockpit
    ON cockpit_pending_change (cockpit_id, created_at DESC);
