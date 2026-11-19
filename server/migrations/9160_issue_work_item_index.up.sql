-- Plan-tree reads page issues by work item ("expanded to N, load the rest"),
-- so the lookup is (workspace, work_item_id) with the unfiled majority excluded.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_issue_work_item
    ON issue (workspace_id, work_item_id)
    WHERE work_item_id IS NOT NULL;
