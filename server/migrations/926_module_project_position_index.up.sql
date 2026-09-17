-- Fork-only (900-999 range): module lists read in position order within one
-- project. See 923 for the table.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_module_project_position
    ON module (project_id, position);
