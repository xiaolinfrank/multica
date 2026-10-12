-- R1 (design-principles-2026-10-12): the work package is dissolved. Minutes
-- state lives on cockpit_meeting (minutes_* columns); the minutes binding is
-- a cockpit_meeting_issue roles entry ('minutes'), so a meeting can bind
-- several minutes tasks and unbind any of them at will. "released" is a
-- projection (a minutes task left backlog), not a stored terminal fact.

-- name: GetCockpitMeetingWorkPackage :one
SELECT m.id AS meeting_id, m.minutes_revision AS revision,
 m.minutes_focus_issue_id AS minutes_issue_id, m.minutes_reviewer_id AS reviewer_id,
 m.minutes_materials_ready AS materials_ready,
 m.minutes_materials_confirmed_at AS materials_confirmed_at, m.minutes_materials_confirmed_by AS materials_confirmed_by,
 m.minutes_current_version_id AS current_version_id, m.minutes_published_version_id AS published_version_id,
 m.minutes_configured_by AS configured_by,
 EXISTS(SELECT 1 FROM cockpit_meeting_issue l JOIN issue i ON i.workspace_id=l.workspace_id AND i.id=l.issue_id
  WHERE l.workspace_id=m.workspace_id AND l.meeting_id=m.id AND 'minutes'=ANY(l.roles) AND i.status IN ('todo','in_progress','in_review','blocked'))::bool AS released
FROM cockpit_meeting m WHERE m.workspace_id=$1 AND m.id=$2;

-- name: LockCockpitMeetingWorkPackage :one
SELECT m.id AS meeting_id, m.minutes_revision AS revision,
 m.minutes_focus_issue_id AS minutes_issue_id, m.minutes_reviewer_id AS reviewer_id,
 m.minutes_materials_ready AS materials_ready,
 m.minutes_materials_confirmed_at AS materials_confirmed_at, m.minutes_materials_confirmed_by AS materials_confirmed_by,
 m.minutes_current_version_id AS current_version_id, m.minutes_published_version_id AS published_version_id,
 m.minutes_configured_by AS configured_by,
 EXISTS(SELECT 1 FROM cockpit_meeting_issue l JOIN issue i ON i.workspace_id=l.workspace_id AND i.id=l.issue_id
  WHERE l.workspace_id=m.workspace_id AND l.meeting_id=m.id AND 'minutes'=ANY(l.roles) AND i.status IN ('todo','in_progress','in_review','blocked'))::bool AS released
FROM cockpit_meeting m WHERE m.workspace_id=$1 AND m.id=$2 FOR UPDATE;

-- name: ListCockpitMinutesIssueLinks :many
SELECT l.issue_id, l.role, l.roles, i.status
FROM cockpit_meeting_issue l JOIN issue i ON i.workspace_id=l.workspace_id AND i.id=l.issue_id
WHERE l.workspace_id=$1 AND l.meeting_id=$2 AND 'minutes'=ANY(l.roles)
ORDER BY l.position, l.created_at;

-- name: AttachCockpitMinutesIssueLink :execrows
INSERT INTO cockpit_meeting_issue(workspace_id,meeting_id,issue_id,role,roles)
VALUES($1,$2,$3,'',ARRAY['minutes'])
ON CONFLICT (meeting_id,issue_id) DO UPDATE SET roles=array_append(cockpit_meeting_issue.roles,'minutes')
WHERE NOT ('minutes'=ANY(cockpit_meeting_issue.roles));

-- name: DetachCockpitMinutesIssueLink :execrows
UPDATE cockpit_meeting_issue SET roles=array_remove(roles,'minutes')
WHERE workspace_id=$1 AND meeting_id=$2 AND issue_id=$3 AND 'minutes'=ANY(roles);

-- name: SetCockpitMinutesSetup :one
UPDATE cockpit_meeting SET minutes_focus_issue_id=sqlc.arg('focus_issue_id')::uuid,
 minutes_reviewer_id=sqlc.arg('reviewer_id')::uuid,
 minutes_configured_by=COALESCE(minutes_configured_by,sqlc.arg('actor_id')::uuid),
 minutes_revision=minutes_revision+1, updated_at=now()
WHERE workspace_id=sqlc.arg('workspace_id')::uuid AND id=sqlc.arg('meeting_id')::uuid
 AND minutes_revision=sqlc.arg('expected_revision')::bigint
RETURNING id AS meeting_id, minutes_revision AS revision,
 minutes_focus_issue_id AS minutes_issue_id, minutes_reviewer_id AS reviewer_id,
 minutes_materials_ready AS materials_ready,
 minutes_materials_confirmed_at AS materials_confirmed_at, minutes_materials_confirmed_by AS materials_confirmed_by,
 minutes_current_version_id AS current_version_id, minutes_published_version_id AS published_version_id, minutes_configured_by AS configured_by;

-- name: SetCockpitMeetingReadiness :one
UPDATE cockpit_meeting SET
 minutes_materials_confirmed_at=CASE WHEN sqlc.narg('materials_ready')::bool IS NOT NULL THEN now() ELSE minutes_materials_confirmed_at END,
 minutes_materials_confirmed_by=CASE WHEN sqlc.narg('materials_ready')::bool IS NOT NULL THEN sqlc.arg('actor_id')::uuid ELSE minutes_materials_confirmed_by END,
 minutes_materials_ready=COALESCE(sqlc.narg('materials_ready')::bool,minutes_materials_ready),
 minutes_revision=minutes_revision+1,updated_at=now()
WHERE workspace_id=$1 AND id=$2 AND minutes_revision=sqlc.arg('expected_revision')::bigint
RETURNING id AS meeting_id, minutes_revision AS revision,
 minutes_focus_issue_id AS minutes_issue_id, minutes_reviewer_id AS reviewer_id,
 minutes_materials_ready AS materials_ready,
 minutes_materials_confirmed_at AS materials_confirmed_at, minutes_materials_confirmed_by AS materials_confirmed_by,
 minutes_current_version_id AS current_version_id, minutes_published_version_id AS published_version_id, minutes_configured_by AS configured_by;

-- name: AdvanceCockpitWorkflowRevision :one
UPDATE cockpit_meeting SET minutes_revision=minutes_revision+1,updated_at=now()
WHERE workspace_id=$1 AND id=$2 AND minutes_revision=$3
RETURNING id AS meeting_id, minutes_revision AS revision,
 minutes_focus_issue_id AS minutes_issue_id, minutes_reviewer_id AS reviewer_id,
 minutes_materials_ready AS materials_ready,
 minutes_materials_confirmed_at AS materials_confirmed_at, minutes_materials_confirmed_by AS materials_confirmed_by,
 minutes_current_version_id AS current_version_id, minutes_published_version_id AS published_version_id, minutes_configured_by AS configured_by;

-- name: SetCockpitCurrentMinutesVersion :one
UPDATE cockpit_meeting SET minutes_current_version_id=$3,minutes_revision=minutes_revision+1,updated_at=now()
WHERE workspace_id=$1 AND id=$2 AND minutes_revision=$4
RETURNING id AS meeting_id, minutes_revision AS revision,
 minutes_focus_issue_id AS minutes_issue_id, minutes_reviewer_id AS reviewer_id,
 minutes_materials_ready AS materials_ready,
 minutes_materials_confirmed_at AS materials_confirmed_at, minutes_materials_confirmed_by AS materials_confirmed_by,
 minutes_current_version_id AS current_version_id, minutes_published_version_id AS published_version_id, minutes_configured_by AS configured_by;

-- name: SetCockpitPublishedMinutesVersion :one
UPDATE cockpit_meeting SET minutes_published_version_id=$3,minutes_revision=minutes_revision+1,updated_at=now()
WHERE workspace_id=$1 AND id=$2 AND minutes_revision=$4 AND minutes_current_version_id=$3
RETURNING id AS meeting_id, minutes_revision AS revision,
 minutes_focus_issue_id AS minutes_issue_id, minutes_reviewer_id AS reviewer_id,
 minutes_materials_ready AS materials_ready,
 minutes_materials_confirmed_at AS materials_confirmed_at, minutes_materials_confirmed_by AS materials_confirmed_by,
 minutes_current_version_id AS current_version_id, minutes_published_version_id AS published_version_id, minutes_configured_by AS configured_by;

-- name: PublishCockpitMinutesVersion :one
UPDATE cockpit_minutes_version SET published_by=$4,published_at=now()
WHERE workspace_id=$1 AND meeting_id=$2 AND id=$3 AND decision='approved' AND published_at IS NULL RETURNING *;

-- name: ListCockpitMinutesVersions :many
SELECT * FROM cockpit_minutes_version WHERE workspace_id=$1 AND meeting_id=$2 ORDER BY version_number DESC;

-- name: GetCockpitMinutesVersion :one
SELECT * FROM cockpit_minutes_version WHERE workspace_id=$1 AND meeting_id=$2 AND id=$3;

-- name: GetCockpitMinutesSubmission :one
SELECT * FROM cockpit_minutes_version WHERE workspace_id=$1 AND meeting_id=$2 AND submission_key=$3;

-- name: CreateCockpitMinutesVersion :one
INSERT INTO cockpit_minutes_version(id,workspace_id,meeting_id,version_number,submission_key,content,content_hash,source_issue_id,review_issue_id,reviewer_id,submitted_by_type,submitted_by_id)
VALUES($1,$2,$3,(SELECT COALESCE(MAX(version_number),0)+1 FROM cockpit_minutes_version WHERE workspace_id=$2 AND meeting_id=$3),$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *;

-- name: ReviewCockpitMinutesVersion :one
UPDATE cockpit_minutes_version SET decision=$4,feedback=$5,reviewed_by=$6,reviewed_at=now()
WHERE workspace_id=$1 AND meeting_id=$2 AND id=$3 AND decision='pending' RETURNING *;

-- name: CockpitIssueExecutionBlocked :one
SELECT EXISTS(SELECT 1 FROM cockpit_meeting_issue l
 JOIN cockpit_meeting m ON m.workspace_id=l.workspace_id AND m.id=l.meeting_id
 WHERE l.issue_id=sqlc.arg('issue_id')::uuid AND 'minutes'=ANY(l.roles)
   AND (m.ended_at IS NULL OR NOT m.minutes_materials_ready)
 UNION ALL SELECT 1 FROM cockpit_minutes_version v WHERE v.review_issue_id=sqlc.arg('issue_id')::uuid
 UNION ALL SELECT 1 FROM cockpit_reviewer_handoff h WHERE h.from_review_issue_id=sqlc.arg('issue_id')::uuid OR h.to_review_issue_id=sqlc.arg('issue_id')::uuid UNION ALL SELECT 1 WHERE cockpit_artifact_is_review_issue(sqlc.arg('issue_id')::uuid))::bool AS blocked;

-- name: CockpitIssueHasWorkflow :one
SELECT EXISTS(SELECT 1 FROM cockpit_meeting_issue l WHERE l.issue_id=sqlc.arg('issue_id')::uuid AND 'minutes'=ANY(l.roles)
 UNION ALL SELECT 1 FROM cockpit_minutes_version v WHERE v.review_issue_id=sqlc.arg('issue_id')::uuid
 UNION ALL SELECT 1 FROM cockpit_reviewer_handoff h WHERE h.from_review_issue_id=sqlc.arg('issue_id')::uuid OR h.to_review_issue_id=sqlc.arg('issue_id')::uuid UNION ALL SELECT 1 WHERE cockpit_artifact_is_review_issue(sqlc.arg('issue_id')::uuid))::bool AS linked;

-- name: DeleteCockpitMinutesVersionsByWorkspace :exec
DELETE FROM cockpit_minutes_version WHERE workspace_id=$1;

-- name: DeleteCockpitMinutesLinksByWorkspace :exec
DELETE FROM cockpit_meeting_issue WHERE workspace_id=$1 AND 'minutes'=ANY(roles);
