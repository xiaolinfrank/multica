-- name: ListIssueMeetingDirectories :many
-- The distinct meeting folders of the meetings this issue works for. Only the
-- links that carry a meeting's own work count: follow-up actions, deliveries
-- and references stay with the issue's filing. Two rows are enough to tell one
-- folder from an ambiguous binding. meeting_id names the meeting where a person
-- prepares the folder: an open meeting before an archived or cancelled one,
-- then the earliest.
SELECT m.nas_dir,
       (array_agg(m.id ORDER BY (m.archived_at IS NOT NULL), (m.cancelled_at IS NOT NULL), m.created_at, m.id))[1]::uuid AS meeting_id
FROM cockpit_meeting_issue AS l
JOIN cockpit_meeting AS m ON m.id = l.meeting_id AND m.workspace_id = l.workspace_id
WHERE l.workspace_id = sqlc.arg('workspace_id')::uuid
  AND l.issue_id = sqlc.arg('issue_id')::uuid
  AND (l.role = 'task' OR l.roles && ARRAY['task', 'preparation', 'support', 'minutes', 'review']::text[])
  AND btrim(m.nas_dir) <> ''
GROUP BY m.nas_dir
LIMIT 2;

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
