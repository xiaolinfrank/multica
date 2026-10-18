-- name: LockCockpitMeetingForWork :one
SELECT * FROM cockpit_meeting
WHERE id = sqlc.arg('id')::uuid AND workspace_id = sqlc.arg('workspace_id')::uuid
FOR UPDATE;

-- name: GetCockpitMeetingIssue :one
SELECT * FROM cockpit_meeting_issue
WHERE workspace_id = sqlc.arg('workspace_id')::uuid
  AND meeting_id = sqlc.arg('meeting_id')::uuid
  AND issue_id = sqlc.arg('issue_id')::uuid;

-- name: UpdateCockpitMeetingIssueRoles :one
UPDATE cockpit_meeting_issue SET roles = sqlc.arg('roles')::text[]
WHERE workspace_id = sqlc.arg('workspace_id')::uuid
  AND meeting_id = sqlc.arg('meeting_id')::uuid
  AND issue_id = sqlc.arg('issue_id')::uuid
RETURNING *;

-- name: DeleteCockpitMeetingIssuesExcept :exec
DELETE FROM cockpit_meeting_issue
WHERE workspace_id = sqlc.arg('workspace_id')::uuid
  AND meeting_id = sqlc.arg('meeting_id')::uuid
  AND NOT (issue_id = ANY(sqlc.arg('issue_ids')::uuid[]));

-- name: GetCockpitMeetingTaskIssue :one
SELECT i.* FROM issue i
JOIN cockpit_meeting_issue l ON l.issue_id = i.id AND l.workspace_id = i.workspace_id
WHERE l.workspace_id = sqlc.arg('workspace_id')::uuid
  AND l.meeting_id = sqlc.arg('meeting_id')::uuid
  AND l.role = 'task'
ORDER BY l.created_at, l.issue_id
LIMIT 1;
