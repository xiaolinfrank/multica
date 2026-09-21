-- Fork-only (900-999 range): the gantt reads this the other way round — every
-- meeting that touched one node — and node deletion sweeps by it.
-- See 934 for the table.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_cockpit_meeting_node_node
    ON cockpit_meeting_node (node_id);
