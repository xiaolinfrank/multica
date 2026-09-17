-- Fork-only (900-999 range): module lanes, module grouping, and module
-- filters read an issue's module. Partial because most issues carry none.
-- See 923 for the column.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_issue_module
    ON issue (module_id) WHERE module_id IS NOT NULL;
