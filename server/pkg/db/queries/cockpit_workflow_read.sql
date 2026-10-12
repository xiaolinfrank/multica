-- name: GetCockpitMeetingWorkPackageForRead :one
SELECT m.id AS meeting_id, m.minutes_revision AS revision,
 m.minutes_focus_issue_id AS minutes_issue_id, m.minutes_reviewer_id AS reviewer_id,
 m.minutes_materials_ready AS materials_ready,
 m.minutes_materials_confirmed_at AS materials_confirmed_at, m.minutes_materials_confirmed_by AS materials_confirmed_by,
 m.minutes_current_version_id AS current_version_id, m.minutes_published_version_id AS published_version_id,
 m.minutes_configured_by AS configured_by,
 (SELECT max(i.updated_at) FROM cockpit_meeting_issue l JOIN issue i ON i.workspace_id=l.workspace_id AND i.id=l.issue_id
  WHERE l.workspace_id=m.workspace_id AND l.meeting_id=m.id AND 'minutes'=ANY(l.roles) AND i.status IN ('todo','in_progress','in_review','blocked'))::timestamptz AS released_at,
 (SELECT t.id FROM agent_task_queue t JOIN cockpit_meeting_issue l2 ON l2.workspace_id=m.workspace_id AND l2.issue_id=t.issue_id AND l2.meeting_id=m.id WHERE l2.workspace_id=m.workspace_id AND 'minutes'=ANY(l2.roles) ORDER BY t.created_at DESC LIMIT 1) AS release_task_id
FROM cockpit_meeting m
WHERE m.workspace_id = $1 AND m.id = $2
FOR SHARE;

-- name: ListCockpitWorkflowIssues :many
SELECT * FROM issue
WHERE workspace_id = sqlc.arg('workspace_id')::uuid
  AND id = ANY(sqlc.arg('issue_ids')::uuid[]);

-- name: CockpitMeetingWorkflowRequiredRole :one
SELECT CASE
 WHEN EXISTS(SELECT 1 FROM cockpit_meeting_issue l WHERE l.workspace_id=sqlc.arg('workspace_id')::uuid AND l.meeting_id=sqlc.arg('meeting_id')::uuid AND l.issue_id=sqlc.arg('issue_id')::uuid AND 'minutes'=ANY(l.roles)) THEN 'minutes'
 WHEN EXISTS(SELECT 1 FROM cockpit_minutes_version v WHERE v.workspace_id=sqlc.arg('workspace_id')::uuid AND v.meeting_id=sqlc.arg('meeting_id')::uuid AND v.review_issue_id=sqlc.arg('issue_id')::uuid) THEN 'review'
 WHEN EXISTS(SELECT 1 FROM cockpit_reviewer_handoff h WHERE h.workspace_id=sqlc.arg('workspace_id')::uuid AND h.meeting_id=sqlc.arg('meeting_id')::uuid AND (h.from_review_issue_id=sqlc.arg('issue_id')::uuid OR h.to_review_issue_id=sqlc.arg('issue_id')::uuid)) THEN 'review'
 ELSE '' END::text AS role;

-- name: ListCockpitMeetingWorkflowIssueIDs :many
SELECT l.issue_id FROM cockpit_meeting_issue l
WHERE l.workspace_id=sqlc.arg('workspace_id')::uuid AND l.meeting_id=sqlc.arg('meeting_id')::uuid AND 'minutes'=ANY(l.roles)
UNION
SELECT v.review_issue_id AS issue_id FROM cockpit_minutes_version v
WHERE v.workspace_id=sqlc.arg('workspace_id')::uuid AND v.meeting_id=sqlc.arg('meeting_id')::uuid
UNION
SELECT h.from_review_issue_id AS issue_id FROM cockpit_reviewer_handoff h
WHERE h.workspace_id=sqlc.arg('workspace_id')::uuid AND h.meeting_id=sqlc.arg('meeting_id')::uuid AND h.from_review_issue_id IS NOT NULL
UNION
SELECT h.to_review_issue_id AS issue_id FROM cockpit_reviewer_handoff h
WHERE h.workspace_id=sqlc.arg('workspace_id')::uuid AND h.meeting_id=sqlc.arg('meeting_id')::uuid AND h.to_review_issue_id IS NOT NULL;

-- name: CockpitWorkflowIssueHasActiveTask :one
SELECT EXISTS(SELECT 1 FROM agent_task_queue t WHERE t.issue_id=sqlc.arg('issue_id')::uuid
 AND t.status IN ('queued','deferred','dispatched','running','waiting_local_directory'))::bool AS active;

-- name: HasCockpitMinutesLinksForBoard :one
SELECT EXISTS(SELECT 1 FROM cockpit_meeting_issue l JOIN cockpit_meeting m ON m.workspace_id=l.workspace_id AND m.id=l.meeting_id
 WHERE l.workspace_id=sqlc.arg('workspace_id')::uuid AND m.cockpit_id=sqlc.arg('cockpit_id')::uuid AND 'minutes'=ANY(l.roles))::bool AS has_links;

-- name: CockpitWorkflowReferencesIssue :one
SELECT EXISTS(SELECT 1 FROM cockpit_meeting_issue l WHERE l.workspace_id=sqlc.arg('workspace_id')::uuid AND l.issue_id=sqlc.arg('issue_id')::uuid AND 'minutes'=ANY(l.roles)
 UNION ALL SELECT 1 FROM cockpit_minutes_version v WHERE v.workspace_id=sqlc.arg('workspace_id')::uuid AND (v.review_issue_id=sqlc.arg('issue_id')::uuid OR v.source_issue_id=sqlc.arg('issue_id')::uuid)
 UNION ALL SELECT 1 FROM cockpit_reviewer_handoff h WHERE h.workspace_id=sqlc.arg('workspace_id')::uuid AND (h.from_review_issue_id=sqlc.arg('issue_id')::uuid OR h.to_review_issue_id=sqlc.arg('issue_id')::uuid))::bool AS referenced;

-- name: CountCockpitMinutesVersions :one
SELECT count(*)::bigint AS versions FROM cockpit_minutes_version WHERE workspace_id=sqlc.arg('workspace_id')::uuid AND meeting_id=sqlc.arg('meeting_id')::uuid;
