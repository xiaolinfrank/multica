-- BayClaw fork (900-999 range). Single-statement file required for
-- CREATE INDEX CONCURRENTLY. pg_trgm is already enabled (migration 137).
-- Speeds up filename ILIKE matches for GET /api/attachments/search, the
-- cross-issue @file mention search.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_attachment_filename_trgm
    ON attachment USING gin (filename gin_trgm_ops);
