-- name: AllocateIssueDirectoryName :one
-- One atomic first allocation. The `directory_name IS NULL` guard is the whole
-- point: two deliveries of the same task (an agent claim racing a human
-- opening the folder) must land on one name, and the loser reads the winner's
-- value back rather than overwriting it. No row comes back when the name was
-- already set.
UPDATE issue SET directory_name = sqlc.arg('directory_name')::text, updated_at = now()
WHERE id = sqlc.arg('id')::uuid
  AND workspace_id = sqlc.arg('workspace_id')::uuid
  AND directory_name IS NULL
RETURNING directory_name;

-- name: UpdateIssueDirectoryName :one
-- A human pointing the task at a folder name they already use. This writes the
-- database only: the files stay where they are, which is the point — adopting
-- a historical folder must not move it.
UPDATE issue SET directory_name = sqlc.arg('directory_name')::text, updated_at = now()
WHERE id = sqlc.arg('id')::uuid
  AND workspace_id = sqlc.arg('workspace_id')::uuid
RETURNING *;

-- name: ListIssueSubtreeDirectoryRows :many
-- Every issue in the subtree (the parent included) with the bindings its
-- delivery folder is derived from. Read before a move so the old path is
-- known; the move itself rewrites the bindings.
WITH RECURSIVE subtree AS (
    SELECT i.id
    FROM issue AS i
    WHERE i.id = sqlc.arg('issue_id')::uuid
      AND i.workspace_id = sqlc.arg('workspace_id')::uuid
  UNION
    SELECT i.id
    FROM issue AS i
    JOIN subtree AS s ON i.parent_issue_id = s.id
    WHERE i.workspace_id = sqlc.arg('workspace_id')::uuid
)
SELECT i.id, i.number, i.directory_name, i.project_id, i.module_id, i.work_item_id
FROM issue AS i
JOIN subtree AS s ON s.id = i.id
ORDER BY i.number;

-- name: ListRunningAgentTasksForIssue :many
-- Queued/dispatched/running work that would have the directory renamed under
-- it. The caller decides what to do with the list; this is a read.
SELECT t.id AS task_id, t.issue_id, i.number AS issue_number, t.status
FROM agent_task_queue AS t
JOIN issue AS i ON i.id = t.issue_id
WHERE t.issue_id = sqlc.arg('issue_id')::uuid
  AND i.workspace_id = sqlc.arg('workspace_id')::uuid
  AND t.status IN ('queued', 'dispatched', 'running')
ORDER BY t.created_at, t.id;

-- name: ListRunningAgentTasksForIssues :many
SELECT t.id AS task_id, t.issue_id, i.number AS issue_number, t.status
FROM agent_task_queue AS t
JOIN issue AS i ON i.id = t.issue_id
WHERE t.issue_id = ANY(sqlc.arg('issue_ids')::uuid[])
  AND i.workspace_id = sqlc.arg('workspace_id')::uuid
  AND t.status IN ('queued', 'dispatched', 'running')
ORDER BY t.created_at, t.id;

-- name: ListRunningAgentTasksForModules :many
-- Any task filed under the module counts, work items included: renaming the
-- module moves every folder below it.
SELECT t.id AS task_id, t.issue_id, i.number AS issue_number, t.status
FROM agent_task_queue AS t
JOIN issue AS i ON i.id = t.issue_id
WHERE i.module_id = ANY(sqlc.arg('module_ids')::uuid[])
  AND i.workspace_id = sqlc.arg('workspace_id')::uuid
  AND t.status IN ('queued', 'dispatched', 'running')
ORDER BY t.created_at, t.id;

-- name: ListRunningAgentTasksForWorkItems :many
SELECT t.id AS task_id, t.issue_id, i.number AS issue_number, t.status
FROM agent_task_queue AS t
JOIN issue AS i ON i.id = t.issue_id
WHERE i.work_item_id = ANY(sqlc.arg('work_item_ids')::uuid[])
  AND i.workspace_id = sqlc.arg('workspace_id')::uuid
  AND t.status IN ('queued', 'dispatched', 'running')
ORDER BY t.created_at, t.id;

-- name: ListProjectsWithCollabPath :many
-- Every project that points at a collaboration space, across all workspaces.
-- Two projects sharing one root would share folders, so the directory panel
-- warns before an agent writes into a folder another workspace also owns.
-- The comparison is done in Go after normalising the path: the database has no
-- opinion on `SMB://host/share` vs `/Volumes/share`.
SELECT p.id AS project_id, p.workspace_id, w.slug AS workspace_slug, w.name AS workspace_name,
       p.title AS project_title, p.collab_path
FROM project AS p
JOIN workspace AS w ON w.id = p.workspace_id
WHERE p.collab_path IS NOT NULL AND btrim(p.collab_path) <> ''
ORDER BY p.collab_path, p.id;
