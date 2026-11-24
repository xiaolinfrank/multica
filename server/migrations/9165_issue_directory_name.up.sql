-- Fork-only: the delivery folder a task's files live in, one path segment
-- under its module (and work item) inside the project's collaboration space.
-- Allocated the first time the task is delivered — at claim time for an agent
-- task, or when a human opens the folder — never on the issue list read path.
-- NULL means "not allocated yet"; a project without `collab_path` never gets
-- one.
ALTER TABLE issue ADD COLUMN IF NOT EXISTS directory_name TEXT;
