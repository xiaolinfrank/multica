-- name: GetCockpitMeetingWorkPackageForRead :one
SELECT * FROM cockpit_meeting_work_package
WHERE workspace_id = $1 AND meeting_id = $2
FOR SHARE;

-- name: ListCockpitWorkflowIssues :many
SELECT * FROM issue
WHERE workspace_id = sqlc.arg('workspace_id')::uuid
  AND id = ANY(sqlc.arg('issue_ids')::uuid[]);

-- name: CockpitMeetingWorkflowRequiredRole :one
SELECT CASE
 WHEN EXISTS(SELECT 1 FROM cockpit_meeting_work_package w WHERE w.workspace_id=sqlc.arg('workspace_id')::uuid AND w.meeting_id=sqlc.arg('meeting_id')::uuid AND w.minutes_issue_id=sqlc.arg('issue_id')::uuid) THEN 'minutes'
 WHEN EXISTS(SELECT 1 FROM cockpit_minutes_version v WHERE v.workspace_id=sqlc.arg('workspace_id')::uuid AND v.meeting_id=sqlc.arg('meeting_id')::uuid AND v.review_issue_id=sqlc.arg('issue_id')::uuid) THEN 'review'
 WHEN EXISTS(SELECT 1 FROM cockpit_reviewer_handoff h WHERE h.workspace_id=sqlc.arg('workspace_id')::uuid AND h.meeting_id=sqlc.arg('meeting_id')::uuid AND (h.from_review_issue_id=sqlc.arg('issue_id')::uuid OR h.to_review_issue_id=sqlc.arg('issue_id')::uuid)) THEN 'review'
 ELSE '' END::text AS role;

-- name: ListCockpitMeetingWorkflowIssueIDs :many
SELECT w.minutes_issue_id AS issue_id FROM cockpit_meeting_work_package w
WHERE w.workspace_id=sqlc.arg('workspace_id')::uuid AND w.meeting_id=sqlc.arg('meeting_id')::uuid
UNION
SELECT v.review_issue_id AS issue_id FROM cockpit_minutes_version v
WHERE v.workspace_id=sqlc.arg('workspace_id')::uuid AND v.meeting_id=sqlc.arg('meeting_id')::uuid
UNION
SELECT h.from_review_issue_id AS issue_id FROM cockpit_reviewer_handoff h
WHERE h.workspace_id=sqlc.arg('workspace_id')::uuid AND h.meeting_id=sqlc.arg('meeting_id')::uuid AND h.from_review_issue_id IS NOT NULL
UNION
SELECT h.to_review_issue_id AS issue_id FROM cockpit_reviewer_handoff h
WHERE h.workspace_id=sqlc.arg('workspace_id')::uuid AND h.meeting_id=sqlc.arg('meeting_id')::uuid AND h.to_review_issue_id IS NOT NULL;
