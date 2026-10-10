-- name: GetCockpitAcceptanceDefinition :one
SELECT * FROM cockpit_acceptance_definition WHERE workspace_id=$1 AND node_id=$2;

-- name: LockCockpitAcceptanceDefinition :one
SELECT * FROM cockpit_acceptance_definition WHERE workspace_id=$1 AND node_id=$2 FOR UPDATE;

-- name: CreateCockpitAcceptanceDefinition :one
INSERT INTO cockpit_acceptance_definition(workspace_id,node_id,created_by,last_updated_by,last_request_hash) VALUES($1,$2,$3,$3,$4) RETURNING *;

-- name: UpdateCockpitAcceptanceDefinition :one
UPDATE cockpit_acceptance_definition SET revision=revision+1,last_updated_by=$3,last_request_hash=$4,updated_at=now() WHERE workspace_id=$1 AND node_id=$2 RETURNING *;

-- name: SetCockpitAcceptanceCurrentRequest :one
UPDATE cockpit_acceptance_definition SET current_request_id=$3,updated_at=now() WHERE workspace_id=$1 AND node_id=$2 RETURNING *;

-- name: SetCockpitAcceptanceApprovedRequest :one
UPDATE cockpit_acceptance_definition SET last_approved_request_id=$3,updated_at=now() WHERE workspace_id=$1 AND node_id=$2 RETURNING *;

-- name: ListCockpitAcceptanceCriteria :many
SELECT * FROM cockpit_acceptance_criterion WHERE workspace_id=$1 AND node_id=$2 AND removed_at IS NULL ORDER BY position,id;

-- name: RetireCockpitAcceptanceCriteria :exec
UPDATE cockpit_acceptance_criterion SET removed_at=now(),updated_at=now() WHERE workspace_id=$1 AND node_id=$2 AND removed_at IS NULL AND NOT(id=ANY($3::uuid[]));

-- name: UpsertCockpitAcceptanceCriterion :one
INSERT INTO cockpit_acceptance_criterion(id,workspace_id,node_id,title,description,position) VALUES($1,$2,$3,$4,$5,$6)
ON CONFLICT(id) DO UPDATE SET title=EXCLUDED.title,description=EXCLUDED.description,position=EXCLUDED.position,revision=cockpit_acceptance_criterion.revision+1,removed_at=NULL,updated_at=now()
WHERE cockpit_acceptance_criterion.workspace_id=EXCLUDED.workspace_id AND cockpit_acceptance_criterion.node_id=EXCLUDED.node_id RETURNING *;

-- name: GetCockpitAcceptanceRequest :one
SELECT * FROM cockpit_acceptance_request WHERE workspace_id=$1 AND node_id=$2 AND id=$3;

-- name: GetCockpitAcceptanceRequestByKey :one
SELECT * FROM cockpit_acceptance_request WHERE workspace_id=$1 AND node_id=$2 AND request_key=$3;

-- name: CreateCockpitAcceptanceRequest :one
INSERT INTO cockpit_acceptance_request(id,workspace_id,node_id,request_key,request_hash,criteria_revision,evidence_hash,reviewer_id,review_issue_id,note,supersedes_request_id,created_by)
VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *;

-- name: SupersedeCockpitAcceptanceRequest :one
UPDATE cockpit_acceptance_request SET superseded_by_request_id=$4,superseded_at=now(),revision=revision+1,updated_at=now() WHERE workspace_id=$1 AND node_id=$2 AND id=$3 AND decision='pending' AND superseded_at IS NULL RETURNING *;

-- name: ReviewCockpitAcceptanceRequest :one
UPDATE cockpit_acceptance_request SET decision=$4,feedback=$5,reviewed_by=$6,reviewed_at=now(),revision=revision+1,updated_at=now() WHERE workspace_id=$1 AND node_id=$2 AND id=$3 RETURNING *;

-- name: SetCockpitAcceptanceRequestReviewer :one
UPDATE cockpit_acceptance_request SET reviewer_id=$4,review_issue_id=$5,revision=revision+1,updated_at=now() WHERE workspace_id=$1 AND node_id=$2 AND id=$3 RETURNING *;

-- name: CreateCockpitAcceptanceRequestCriterion :exec
INSERT INTO cockpit_acceptance_request_criterion(workspace_id,request_id,criterion_id,title,description,position,revision) VALUES($1,$2,$3,$4,$5,$6,$7);

-- name: CreateCockpitAcceptanceEvidence :exec
INSERT INTO cockpit_acceptance_evidence(workspace_id,request_id,criterion_id,version_id,artifact_id,content_hash) VALUES($1,$2,$3,$4,$5,$6);

-- name: ListCockpitAcceptanceRequestCriteria :many
SELECT * FROM cockpit_acceptance_request_criterion WHERE workspace_id=$1 AND request_id=$2 ORDER BY position,criterion_id;

-- name: ListCockpitAcceptanceEvidence :many
SELECT e.*,a.approved_version_id,a.owner_node_id,
 (a.owner_node_id=sqlc.arg(node_id) OR EXISTS(SELECT 1 FROM cockpit_artifact_node_reference r WHERE r.workspace_id=e.workspace_id AND r.node_id=sqlc.arg(node_id) AND r.version_id=e.version_id AND r.removed_at IS NULL))::boolean AS eligible
FROM cockpit_acceptance_evidence e JOIN cockpit_artifact a ON a.workspace_id=e.workspace_id AND a.id=e.artifact_id
WHERE e.workspace_id=sqlc.arg(workspace_id) AND e.request_id=sqlc.arg(request_id) ORDER BY e.criterion_id,e.version_id;

-- name: ListCockpitAcceptanceRequests :many
SELECT id,workspace_id,node_id,request_key,revision,criteria_revision,evidence_hash,reviewer_id,review_issue_id,decision,(feedback<>'')::boolean AS has_feedback,created_by,created_at,reviewed_at,supersedes_request_id,superseded_at
FROM cockpit_acceptance_request WHERE workspace_id=sqlc.arg(workspace_id) AND node_id=sqlc.arg(node_id)
AND (sqlc.narg(after_id)::uuid IS NULL OR id>sqlc.narg(after_id)) ORDER BY id LIMIT sqlc.arg(page_limit);

-- name: CountCockpitAcceptanceRequests :one
SELECT count(*) FROM cockpit_acceptance_request WHERE workspace_id=$1 AND node_id=$2;

-- name: ListCockpitAcceptanceVersionSources :many
SELECT v.id,v.artifact_id,v.content_hash,v.capture_status,v.decision,v.payload_kind,v.storage_key,v.size_bytes,v.revision,v.content,
 a.approved_version_id,a.owner_node_id,
 (a.owner_node_id=sqlc.arg(node_id) OR EXISTS(SELECT 1 FROM cockpit_artifact_node_reference r WHERE r.workspace_id=v.workspace_id AND r.node_id=sqlc.arg(node_id) AND r.version_id=v.id AND r.removed_at IS NULL))::boolean AS eligible
FROM cockpit_artifact_version v JOIN cockpit_artifact a ON a.workspace_id=v.workspace_id AND a.id=v.artifact_id
WHERE v.workspace_id=sqlc.arg(workspace_id) AND v.id=ANY(sqlc.arg(version_ids)::uuid[]);
