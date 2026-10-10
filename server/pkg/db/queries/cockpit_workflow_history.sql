-- name: GetCockpitWorkflowMeetingIdentity :one
SELECT id,cockpit_id,nas_dir,ended_at FROM cockpit_meeting WHERE workspace_id=$1 AND id=$2;

-- name: GetCockpitWorkflowSnapshot :one
SELECT * FROM cockpit_meeting_work_package WHERE workspace_id=$1 AND meeting_id=$2;

-- name: CountCockpitWorkflowHistory :one
SELECT
 (SELECT count(*) FROM cockpit_minutes_version v WHERE v.workspace_id=$1 AND v.meeting_id=$2)::bigint AS versions,
 (SELECT count(*) FROM cockpit_reviewer_handoff h WHERE h.workspace_id=$1 AND h.meeting_id=$2)::bigint AS reviewer_handoffs,
 (SELECT count(*) FROM cockpit_minutes_export e WHERE e.workspace_id=$1 AND e.meeting_id=$2)::bigint AS nas_exports,
 (SELECT count(*) FROM cockpit_minutes_export e WHERE e.workspace_id=$1 AND e.meeting_id=$2 AND e.status IN ('queued','running','retry_wait'))::bigint AS nas_active;

-- name: ListCockpitWorkflowIssueCards :many
SELECT i.id,i.title,i.status,i.assignee_type,i.assignee_id,(w.issue_prefix||'-'||i.number::text)::text AS identifier
FROM issue i JOIN workspace w ON w.id=i.workspace_id
WHERE i.workspace_id=sqlc.arg('workspace_id')::uuid AND i.id=ANY(sqlc.arg('issue_ids')::uuid[]);

-- name: ListCockpitVersionMetadata :many
SELECT id,version_number,submission_key,content_hash,source_issue_id,review_issue_id,reviewer_id,decision,
 (feedback<>'')::bool AS has_feedback,submitted_by_type,submitted_by_id,created_at,reviewed_by,reviewed_at,published_by,published_at
FROM cockpit_minutes_version
WHERE workspace_id=sqlc.arg('workspace_id')::uuid AND meeting_id=sqlc.arg('meeting_id')::uuid AND id=ANY(sqlc.arg('version_ids')::uuid[]);

-- name: PageCockpitVersionIDs :many
SELECT id,version_number FROM cockpit_minutes_version
WHERE workspace_id=$1 AND meeting_id=$2 AND (sqlc.narg('cursor_number')::int IS NULL OR version_number<sqlc.narg('cursor_number')::int)
ORDER BY version_number DESC LIMIT sqlc.arg('page_limit')::int;

-- name: PageCockpitHandoffIDs :many
SELECT id,revision FROM cockpit_reviewer_handoff
WHERE workspace_id=$1 AND meeting_id=$2 AND (sqlc.narg('cursor_id')::uuid IS NULL OR (revision,id)<(sqlc.arg('cursor_revision')::bigint,sqlc.narg('cursor_id')::uuid))
ORDER BY revision DESC,id DESC LIMIT sqlc.arg('page_limit')::int;

-- name: ListCockpitHandoffHistoryRows :many
SELECT sqlc.embed(h),v.version_number
FROM cockpit_reviewer_handoff h
LEFT JOIN cockpit_minutes_version v ON v.workspace_id=h.workspace_id AND v.meeting_id=h.meeting_id AND v.id=h.version_id
WHERE h.workspace_id=sqlc.arg('workspace_id')::uuid AND h.meeting_id=sqlc.arg('meeting_id')::uuid AND h.id=ANY(sqlc.arg('handoff_ids')::uuid[]);

-- name: ListCockpitHistoryNames :many
SELECT id,name FROM "user" WHERE id=ANY(sqlc.arg('user_ids')::uuid[]);

-- name: PageCockpitExportIDs :many
SELECT id,created_at FROM cockpit_minutes_export
WHERE workspace_id=sqlc.arg('workspace_id')::uuid AND meeting_id=sqlc.arg('meeting_id')::uuid
 AND (sqlc.narg('version_id')::uuid IS NULL OR version_id=sqlc.narg('version_id')::uuid)
 AND (sqlc.arg('status')::text='' OR status=sqlc.arg('status')::text OR (sqlc.arg('status')::text='active' AND status IN ('queued','running','retry_wait')))
 AND (sqlc.narg('cursor_id')::uuid IS NULL OR (created_at,id)<(sqlc.arg('cursor_created_at')::timestamptz,sqlc.narg('cursor_id')::uuid))
ORDER BY created_at DESC,id DESC LIMIT sqlc.arg('page_limit')::int;

-- name: CountCockpitExportHistory :one
SELECT count(*)::bigint FROM cockpit_minutes_export
WHERE workspace_id=sqlc.arg('workspace_id')::uuid AND meeting_id=sqlc.arg('meeting_id')::uuid
 AND (sqlc.narg('version_id')::uuid IS NULL OR version_id=sqlc.narg('version_id')::uuid)
 AND (sqlc.arg('status')::text='' OR status=sqlc.arg('status')::text OR (sqlc.arg('status')::text='active' AND status IN ('queued','running','retry_wait')));

-- name: ListCockpitExportHistoryRows :many
SELECT * FROM cockpit_minutes_export
WHERE workspace_id=sqlc.arg('workspace_id')::uuid AND meeting_id=sqlc.arg('meeting_id')::uuid AND id=ANY(sqlc.arg('export_ids')::uuid[]);

-- name: CountCockpitVersionHistory :one
SELECT count(*)::bigint FROM cockpit_minutes_version WHERE workspace_id=$1 AND meeting_id=$2;

-- name: CountCockpitHandoffHistory :one
SELECT count(*)::bigint FROM cockpit_reviewer_handoff WHERE workspace_id=$1 AND meeting_id=$2;
