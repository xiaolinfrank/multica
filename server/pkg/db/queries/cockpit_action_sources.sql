-- name: CountCockpitIssueActionSources :one
SELECT count(*)::bigint
FROM cockpit_meeting_action a
JOIN cockpit_meeting m ON m.id=a.meeting_id AND m.workspace_id=a.workspace_id
WHERE a.workspace_id=$1 AND a.issue_id=$2 AND a.status='accepted';

-- name: ListCockpitIssueActionSources :many
SELECT a.id,a.meeting_id,m.code AS meeting_code,m.title AS meeting_title,
 a.version_id,a.version_number,a.title
FROM cockpit_meeting_action a
JOIN cockpit_meeting m ON m.id=a.meeting_id AND m.workspace_id=a.workspace_id
WHERE a.workspace_id=sqlc.arg('workspace_id')::uuid AND a.issue_id=sqlc.arg('issue_id')::uuid AND a.status='accepted'
 AND (sqlc.narg('cursor_id')::uuid IS NULL OR a.id<sqlc.narg('cursor_id')::uuid)
ORDER BY a.id DESC LIMIT sqlc.arg('page_limit')::int;
