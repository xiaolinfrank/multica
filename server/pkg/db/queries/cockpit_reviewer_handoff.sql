-- name: GetCockpitReviewerHandoff :one
SELECT * FROM cockpit_reviewer_handoff
WHERE workspace_id=$1 AND meeting_id=$2 AND handoff_key=$3;

-- name: ListCockpitReviewerHandoffs :many
SELECT * FROM cockpit_reviewer_handoff
WHERE workspace_id=$1 AND meeting_id=$2 ORDER BY revision DESC, id DESC;

-- name: CreateCockpitReviewerHandoff :one
INSERT INTO cockpit_reviewer_handoff (
 id,workspace_id,meeting_id,handoff_key,from_reviewer_id,to_reviewer_id,
 version_id,from_review_issue_id,to_review_issue_id,reason,created_by,revision
) VALUES ($1,$2,$3,$4,$5,$6,sqlc.narg('version_id')::uuid,
 sqlc.narg('from_review_issue_id')::uuid,sqlc.narg('to_review_issue_id')::uuid,$7,$8,$9)
RETURNING *;

-- name: SetCockpitDefaultReviewer :one
UPDATE cockpit_meeting SET minutes_reviewer_id=$3,minutes_revision=minutes_revision+1,updated_at=now()
WHERE workspace_id=$1 AND id=$2 AND minutes_revision=$4
RETURNING id AS meeting_id,minutes_revision AS revision,minutes_focus_issue_id AS minutes_issue_id,minutes_reviewer_id AS reviewer_id,minutes_materials_ready AS materials_ready,minutes_materials_confirmed_at AS materials_confirmed_at,minutes_materials_confirmed_by AS materials_confirmed_by,minutes_current_version_id AS current_version_id,minutes_published_version_id AS published_version_id;

-- name: TransferCockpitPendingReview :one
UPDATE cockpit_minutes_version SET reviewer_id=sqlc.arg('reviewer_id')::uuid,review_issue_id=sqlc.arg('review_issue_id')::uuid
WHERE workspace_id=sqlc.arg('workspace_id')::uuid AND meeting_id=sqlc.arg('meeting_id')::uuid
 AND id=sqlc.arg('version_id')::uuid AND decision='pending'
 AND reviewer_id=sqlc.arg('previous_reviewer_id')::uuid
 AND review_issue_id=sqlc.arg('previous_review_issue_id')::uuid
RETURNING *;

-- name: DeleteCockpitReviewerHandoffsByWorkspace :exec
DELETE FROM cockpit_reviewer_handoff WHERE workspace_id=$1;

-- name: SetCockpitWorkflowActor :exec
SELECT set_config('multica.actor_type','member',true),
       set_config('multica.actor_id',sqlc.arg('actor_id')::uuid::text,true),
       set_config('multica.source_task_id','',true);
