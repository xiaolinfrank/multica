-- BayClaw fork (900-999 range). Single-statement file required for
-- CREATE INDEX CONCURRENTLY. Bounds the "recently active issues" subquery in
-- GET /api/attachments/search: a DESC scan on (workspace_id, created_at) lets
-- Postgres collect the recent issue_ids without touching older activity rows.
-- Existing idx_activity_log_issue (issue_id) is issue-first and cannot serve
-- this workspace+time range filter efficiently.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_activity_log_workspace_created
    ON activity_log (workspace_id, created_at DESC);
