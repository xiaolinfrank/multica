-- name: CreateCockpitArtifactProducerAssignment :one
INSERT INTO cockpit_artifact_producer_assignment(id,workspace_id,artifact_id,command_key,request_hash,from_issue_id,to_issue_id,reason,created_by,expected_revision,resulting_revision) VALUES(sqlc.arg(id),sqlc.arg(workspace_id),sqlc.arg(artifact_id),sqlc.arg(command_key),sqlc.arg(request_hash),sqlc.arg(from_issue_id),sqlc.arg(to_issue_id),sqlc.arg(reason),sqlc.arg(created_by),sqlc.arg(expected_revision),sqlc.arg(resulting_revision)) RETURNING *;

-- name: GetCockpitArtifactProducerAssignmentByKey :one
SELECT * FROM cockpit_artifact_producer_assignment WHERE workspace_id=$1 AND artifact_id=$2 AND command_key=$3;

-- name: ListCockpitArtifactProducerAssignments :many
SELECT * FROM cockpit_artifact_producer_assignment WHERE workspace_id=sqlc.arg(workspace_id) AND artifact_id=sqlc.arg(artifact_id) AND (sqlc.narg(after_id)::uuid IS NULL OR id>sqlc.narg(after_id)) ORDER BY id LIMIT sqlc.arg(page_limit);

-- name: CountCockpitArtifactProducerAssignments :one
SELECT count(*) FROM cockpit_artifact_producer_assignment WHERE workspace_id=$1 AND artifact_id=$2;

-- name: CreateCockpitArtifactReviewerHandoff :one
INSERT INTO cockpit_artifact_reviewer_handoff(id,workspace_id,artifact_id,command_key,request_hash,from_reviewer_id,to_reviewer_id,version_id,version_number,from_review_issue_id,to_review_issue_id,reason,created_by,expected_revision,resulting_revision) VALUES(sqlc.arg(id),sqlc.arg(workspace_id),sqlc.arg(artifact_id),sqlc.arg(command_key),sqlc.arg(request_hash),sqlc.arg(from_reviewer_id),sqlc.arg(to_reviewer_id),sqlc.narg(version_id),sqlc.narg(version_number),sqlc.narg(from_review_issue_id),sqlc.narg(to_review_issue_id),sqlc.arg(reason),sqlc.arg(created_by),sqlc.arg(expected_revision),sqlc.arg(resulting_revision)) RETURNING *;

-- name: GetCockpitArtifactReviewerHandoffByKey :one
SELECT * FROM cockpit_artifact_reviewer_handoff WHERE workspace_id=$1 AND artifact_id=$2 AND command_key=$3;

-- name: ListCockpitArtifactReviewerHandoffs :many
SELECT * FROM cockpit_artifact_reviewer_handoff WHERE workspace_id=sqlc.arg(workspace_id) AND artifact_id=sqlc.arg(artifact_id) AND (sqlc.narg(after_id)::uuid IS NULL OR id>sqlc.narg(after_id)) ORDER BY id LIMIT sqlc.arg(page_limit);

-- name: CountCockpitArtifactReviewerHandoffs :one
SELECT count(*) FROM cockpit_artifact_reviewer_handoff WHERE workspace_id=$1 AND artifact_id=$2;

-- name: CreateCockpitAcceptanceReviewerHandoff :one
INSERT INTO cockpit_acceptance_reviewer_handoff(id,workspace_id,node_id,request_id,command_key,request_hash,from_reviewer_id,to_reviewer_id,from_review_issue_id,to_review_issue_id,reason,created_by,expected_revision,resulting_revision) VALUES(sqlc.arg(id),sqlc.arg(workspace_id),sqlc.arg(node_id),sqlc.arg(request_id),sqlc.arg(command_key),sqlc.arg(request_hash),sqlc.arg(from_reviewer_id),sqlc.arg(to_reviewer_id),sqlc.arg(from_review_issue_id),sqlc.arg(to_review_issue_id),sqlc.arg(reason),sqlc.arg(created_by),sqlc.arg(expected_revision),sqlc.arg(resulting_revision)) RETURNING *;

-- name: GetCockpitAcceptanceReviewerHandoffByKey :one
SELECT * FROM cockpit_acceptance_reviewer_handoff WHERE workspace_id=$1 AND node_id=$2 AND command_key=$3;

-- name: ListCockpitAcceptanceReviewerHandoffs :many
SELECT * FROM cockpit_acceptance_reviewer_handoff WHERE workspace_id=sqlc.arg(workspace_id) AND node_id=sqlc.arg(node_id) AND (sqlc.narg(after_id)::uuid IS NULL OR id>sqlc.narg(after_id)) ORDER BY id LIMIT sqlc.arg(page_limit);

-- name: CountCockpitAcceptanceReviewerHandoffs :one
SELECT count(*) FROM cockpit_acceptance_reviewer_handoff WHERE workspace_id=$1 AND node_id=$2;

-- name: CreateCockpitArtifactNodeReference :one
INSERT INTO cockpit_artifact_node_reference(id,workspace_id,artifact_id,version_id,node_id,target_label,purpose,reference_key,request_hash,created_by) VALUES(sqlc.arg(id),sqlc.arg(workspace_id),sqlc.arg(artifact_id),sqlc.arg(version_id),sqlc.arg(node_id),sqlc.arg(target_label),sqlc.arg(purpose),sqlc.arg(reference_key),sqlc.arg(request_hash),sqlc.arg(created_by)) RETURNING *;

-- name: GetCockpitArtifactNodeReferenceByKey :one
SELECT * FROM cockpit_artifact_node_reference WHERE workspace_id=$1 AND reference_key=$2;

-- name: GetActiveCockpitArtifactNodeReference :one
SELECT * FROM cockpit_artifact_node_reference WHERE workspace_id=$1 AND version_id=$2 AND node_id=$3 AND purpose=$4 AND removed_at IS NULL;

-- name: RemoveCockpitArtifactNodeReference :one
UPDATE cockpit_artifact_node_reference SET removed_at=coalesce(removed_at,now()),removed_by=coalesce(removed_by,$4) WHERE workspace_id=$1 AND artifact_id=$2 AND id=$3 RETURNING *;

-- name: ListCockpitArtifactNodeReferences :many
SELECT * FROM cockpit_artifact_node_reference WHERE workspace_id=sqlc.arg(workspace_id) AND artifact_id=sqlc.arg(artifact_id) AND (sqlc.narg(after_id)::uuid IS NULL OR id>sqlc.narg(after_id)) ORDER BY id LIMIT sqlc.arg(page_limit);

-- name: CountCockpitArtifactNodeReferences :one
SELECT count(*) FROM cockpit_artifact_node_reference WHERE workspace_id=$1 AND artifact_id=$2;

-- name: CreateCockpitArtifactMeetingReference :one
INSERT INTO cockpit_artifact_meeting_reference(id,workspace_id,artifact_id,version_id,meeting_id,target_label,purpose,reference_key,request_hash,created_by) VALUES(sqlc.arg(id),sqlc.arg(workspace_id),sqlc.arg(artifact_id),sqlc.arg(version_id),sqlc.arg(meeting_id),sqlc.arg(target_label),sqlc.arg(purpose),sqlc.arg(reference_key),sqlc.arg(request_hash),sqlc.arg(created_by)) RETURNING *;

-- name: GetCockpitArtifactMeetingReferenceByKey :one
SELECT * FROM cockpit_artifact_meeting_reference WHERE workspace_id=$1 AND reference_key=$2;

-- name: GetActiveCockpitArtifactMeetingReference :one
SELECT * FROM cockpit_artifact_meeting_reference WHERE workspace_id=$1 AND version_id=$2 AND meeting_id=$3 AND purpose=$4 AND removed_at IS NULL;

-- name: RemoveCockpitArtifactMeetingReference :one
UPDATE cockpit_artifact_meeting_reference SET removed_at=coalesce(removed_at,now()),removed_by=coalesce(removed_by,$4) WHERE workspace_id=$1 AND artifact_id=$2 AND id=$3 RETURNING *;

-- name: ListCockpitArtifactMeetingReferences :many
SELECT * FROM cockpit_artifact_meeting_reference WHERE workspace_id=sqlc.arg(workspace_id) AND artifact_id=sqlc.arg(artifact_id) AND (sqlc.narg(after_id)::uuid IS NULL OR id>sqlc.narg(after_id)) ORDER BY id LIMIT sqlc.arg(page_limit);

-- name: CountCockpitArtifactMeetingReferences :one
SELECT count(*) FROM cockpit_artifact_meeting_reference WHERE workspace_id=$1 AND artifact_id=$2;

-- name: ListCockpitMeetingArtifactReferences :many
SELECT r.*,a.title AS artifact_title,v.version_number,v.content_hash FROM cockpit_artifact_meeting_reference r
JOIN cockpit_artifact a ON a.workspace_id=r.workspace_id AND a.id=r.artifact_id
JOIN cockpit_artifact_version v ON v.workspace_id=r.workspace_id AND v.artifact_id=r.artifact_id AND v.id=r.version_id
WHERE r.workspace_id=sqlc.arg(workspace_id) AND r.meeting_id=sqlc.arg(meeting_id)
 AND (sqlc.arg(include_removed)::boolean OR r.removed_at IS NULL)
 AND (sqlc.narg(after_id)::uuid IS NULL OR r.id>sqlc.narg(after_id))
ORDER BY r.id LIMIT sqlc.arg(page_limit);

-- name: CountCockpitMeetingArtifactReferences :one
SELECT count(*) FROM cockpit_artifact_meeting_reference WHERE workspace_id=$1 AND meeting_id=$2 AND ($3::boolean OR removed_at IS NULL);
