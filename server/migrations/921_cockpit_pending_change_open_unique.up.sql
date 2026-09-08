-- One OPEN proposal per (node, field): a second ingest for the same field
-- updates the pending row's proposal instead of racing it (partial unique
-- index, so decided rows never block a fresh proposal for the same field).
-- Concurrent-index build: single statement, outside any transaction.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS uq_cockpit_pending_change_open
    ON cockpit_pending_change (node_id, field)
    WHERE status = 'pending';
