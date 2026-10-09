-- name: GetCockpitMeetingWorkPackage :one
SELECT * FROM cockpit_meeting_work_package WHERE workspace_id=$1 AND meeting_id=$2;

-- name: LockCockpitMeetingWorkPackage :one
SELECT * FROM cockpit_meeting_work_package WHERE workspace_id=$1 AND meeting_id=$2 FOR UPDATE;

-- name: CreateCockpitMeetingWorkPackage :one
INSERT INTO cockpit_meeting_work_package(workspace_id,meeting_id,minutes_issue_id,reviewer_id,created_by)
VALUES($1,$2,$3,$4,$5) RETURNING *;

-- name: SetCockpitMeetingReadiness :one
UPDATE cockpit_meeting_work_package SET
 ended_at=CASE WHEN sqlc.arg('ended')::bool THEN COALESCE(ended_at,now()) ELSE ended_at END,
 materials_ready=COALESCE(sqlc.narg('materials_ready')::bool,materials_ready),
 revision=revision+1,updated_at=now()
WHERE workspace_id=$1 AND meeting_id=$2 AND revision=sqlc.arg('expected_revision')::bigint RETURNING *;

-- name: ReleaseCockpitMeetingWorkPackage :one
UPDATE cockpit_meeting_work_package SET released_at=now(),revision=revision+1,updated_at=now()
WHERE workspace_id=$1 AND meeting_id=$2 AND revision=$3 AND released_at IS NULL
 AND ended_at IS NOT NULL AND materials_ready RETURNING *;

-- name: SetCockpitMeetingReleaseTask :exec
UPDATE cockpit_meeting_work_package SET release_task_id=$3 WHERE workspace_id=$1 AND meeting_id=$2;

-- name: SetCockpitCurrentMinutesVersion :one
UPDATE cockpit_meeting_work_package SET current_version_id=$3,revision=revision+1,updated_at=now()
WHERE workspace_id=$1 AND meeting_id=$2 AND revision=$4 RETURNING *;

-- name: AdvanceCockpitWorkflowRevision :one
UPDATE cockpit_meeting_work_package SET revision=revision+1,updated_at=now()
WHERE workspace_id=$1 AND meeting_id=$2 AND revision=$3 RETURNING *;

-- name: PublishCockpitMinutesVersion :one
UPDATE cockpit_minutes_version SET published_by=$4,published_at=now()
WHERE workspace_id=$1 AND meeting_id=$2 AND id=$3 AND decision='approved' AND published_at IS NULL RETURNING *;

-- name: SetCockpitPublishedMinutesVersion :one
UPDATE cockpit_meeting_work_package SET published_version_id=$3,revision=revision+1,updated_at=now()
WHERE workspace_id=$1 AND meeting_id=$2 AND revision=$4 AND current_version_id=$3 RETURNING *;

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
SELECT EXISTS(SELECT 1 FROM cockpit_meeting_work_package w WHERE w.minutes_issue_id=sqlc.arg('issue_id')::uuid AND w.released_at IS NULL
 UNION ALL SELECT 1 FROM cockpit_minutes_version v WHERE v.review_issue_id=sqlc.arg('issue_id')::uuid
 UNION ALL SELECT 1 FROM cockpit_reviewer_handoff h WHERE h.from_review_issue_id=sqlc.arg('issue_id')::uuid OR h.to_review_issue_id=sqlc.arg('issue_id')::uuid)::bool AS blocked;

-- name: CockpitIssueHasWorkflow :one
SELECT EXISTS(SELECT 1 FROM cockpit_meeting_work_package w WHERE w.minutes_issue_id=sqlc.arg('issue_id')::uuid
 UNION ALL SELECT 1 FROM cockpit_minutes_version v WHERE v.review_issue_id=sqlc.arg('issue_id')::uuid
 UNION ALL SELECT 1 FROM cockpit_reviewer_handoff h WHERE h.from_review_issue_id=sqlc.arg('issue_id')::uuid OR h.to_review_issue_id=sqlc.arg('issue_id')::uuid)::bool AS linked;

-- name: DeleteCockpitMinutesVersionsByWorkspace :exec
DELETE FROM cockpit_minutes_version WHERE workspace_id=$1;

-- name: DeleteCockpitWorkPackagesByWorkspace :exec
DELETE FROM cockpit_meeting_work_package WHERE workspace_id=$1;

-- name: HasCockpitWorkPackagesForBoard :one
SELECT EXISTS(SELECT 1 FROM cockpit_meeting_work_package w JOIN cockpit_meeting m ON m.id=w.meeting_id AND m.workspace_id=w.workspace_id WHERE m.cockpit_id=$1 AND w.workspace_id=$2)::bool;

-- name: CockpitWorkflowReferencesIssue :one
SELECT EXISTS(SELECT 1 FROM cockpit_meeting_work_package w WHERE w.workspace_id=sqlc.arg('workspace_id')::uuid AND w.minutes_issue_id=sqlc.arg('issue_id')::uuid
 UNION ALL SELECT 1 FROM cockpit_meeting_action a WHERE a.workspace_id=sqlc.arg('workspace_id')::uuid AND a.issue_id=sqlc.arg('issue_id')::uuid
 UNION ALL SELECT 1 FROM cockpit_minutes_version v WHERE v.workspace_id=sqlc.arg('workspace_id')::uuid AND (v.review_issue_id=sqlc.arg('issue_id')::uuid OR v.source_issue_id=sqlc.arg('issue_id')::uuid)
 UNION ALL SELECT 1 FROM cockpit_reviewer_handoff h WHERE h.workspace_id=sqlc.arg('workspace_id')::uuid AND (h.from_review_issue_id=sqlc.arg('issue_id')::uuid OR h.to_review_issue_id=sqlc.arg('issue_id')::uuid))::bool AS linked;

-- name: CockpitWorkflowIssueHasActiveTask :one
SELECT EXISTS(SELECT 1 FROM agent_task_queue WHERE issue_id=$1 AND status IN ('queued','deferred','dispatched','running','waiting_local_directory'))::bool;
