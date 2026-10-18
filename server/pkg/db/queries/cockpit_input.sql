-- name: LockCockpitInputRuntimeAuthority :one
SELECT * FROM agent_runtime WHERE id=$1 FOR SHARE;

-- name: LockCockpitInputAgentAuthority :one
SELECT * FROM agent WHERE id=$1 FOR SHARE;

-- name: LockCockpitInputCommand :exec
SELECT pg_advisory_xact_lock(hashtextextended(sqlc.arg(workspace_id)::text || '/cockpit-input/' || sqlc.arg(command_key)::text, 0));

-- name: GetCockpitInput :one
SELECT * FROM cockpit_input WHERE workspace_id=$1 AND id=$2;

-- name: LockCockpitInput :one
SELECT * FROM cockpit_input WHERE workspace_id=$1 AND id=$2 FOR UPDATE;

-- name: GetCockpitInputByCreationKey :one
SELECT * FROM cockpit_input WHERE workspace_id=$1 AND creation_key=$2;

-- name: CreateCockpitInput :one
INSERT INTO cockpit_input (
id,workspace_id,creation_key,request_hash,creation_receipt,title,description,project_id,origin_issue_id,
actor_type,actor_id,credential_owner_user_id,authorizing_user_id,source_agent_id,source_run_id,source_issue_id,source_runtime_id,created_at,updated_at
) VALUES (
$1,$2,$3,$4,$5,$6,$7,sqlc.narg(project_id),sqlc.narg(origin_issue_id),$8,$9,$10,$11,
sqlc.narg(source_agent_id),sqlc.narg(source_run_id),sqlc.narg(source_issue_id),sqlc.narg(source_runtime_id),$12,$12
) RETURNING *;

-- name: EditCockpitInput :one
UPDATE cockpit_input SET title=$3,description=$4,revision=revision+1,updated_at=now()
WHERE workspace_id=$1 AND id=$2 AND revision=$5 RETURNING *;

-- name: ArchiveCockpitInput :one
UPDATE cockpit_input SET archived_at=CASE WHEN sqlc.arg(archived)::boolean THEN now() ELSE NULL END,
archived_by=CASE WHEN sqlc.arg(archived)::boolean THEN sqlc.arg(actor_id)::uuid ELSE NULL END,
revision=revision+1,updated_at=now()
WHERE workspace_id=$1 AND id=$2 AND revision=sqlc.arg(expected_revision)::bigint RETURNING *;

-- name: GetCockpitInputVersion :one
SELECT * FROM cockpit_input_version WHERE workspace_id=$1 AND input_id=$2 AND id=$3;

-- name: LockCockpitInputVersion :one
SELECT * FROM cockpit_input_version WHERE workspace_id=$1 AND input_id=$2 AND id=$3 FOR UPDATE;

-- name: GetCockpitInputVersionBySubmissionKey :one
SELECT * FROM cockpit_input_version WHERE workspace_id=$1 AND input_id=$2 AND submission_key=$3;

-- name: GetCockpitInputVersionsByIDs :many
SELECT id,workspace_id,input_id,version_number,submission_key,request_hash,NULL::jsonb AS submission_receipt,revision,
actor_type,actor_id,credential_owner_user_id,authorizing_user_id,source_agent_id,source_run_id,source_issue_id,source_runtime_id,
source_kind,payload_kind,source_attachment_id,source_attachment_issue_id,source_root_id,source_root_path,source_relative_path,source_root_config_hash,
source_root_identity,source_file_identity,source_size,source_mtime_ns,source_artifact_id,source_artifact_version_id,filename,content_type,
declared_size_bytes,client_sha256,pinned_size_bytes,content_hash,pinned_at,capture_state,capture_error_code,''::text AS capture_error,
active_transfer_id,accepted_transfer_id,current_transfer_id,ready_at,availability,verification_generation,verification_lease_token,
verification_lease_expires_at,verification_due_at,checked_at,proof_expires_at,provider_object_identity,verification_error_code,created_at,updated_at
FROM cockpit_input_version WHERE workspace_id=$1 AND id=ANY(sqlc.arg(ids)::uuid[]);

-- name: GetCockpitInputTransfer :one
SELECT * FROM cockpit_input_transfer WHERE workspace_id=$1 AND input_id=$2 AND version_id=$3 AND id=$4 AND workspace_deleted_at IS NULL;

-- name: LockCockpitInputTransfer :one
SELECT * FROM cockpit_input_transfer WHERE workspace_id=$1 AND input_id=$2 AND version_id=$3 AND id=$4 AND workspace_deleted_at IS NULL FOR UPDATE;

-- name: GetCockpitInputTransferByCommand :one
SELECT * FROM cockpit_input_transfer WHERE workspace_id=$1 AND version_id=$2 AND command_key=$3 AND workspace_deleted_at IS NULL;

-- name: GetCockpitInputReference :one
SELECT * FROM cockpit_input_reference WHERE workspace_id=$1 AND meeting_id=$2 AND id=$3;

-- name: LockCockpitInputReference :one
SELECT * FROM cockpit_input_reference WHERE workspace_id=$1 AND meeting_id=$2 AND id=$3 FOR UPDATE;

-- name: GetCockpitInputReferenceByCreationKey :one
SELECT * FROM cockpit_input_reference WHERE workspace_id=$1 AND meeting_id=$2 AND creation_key=$3;

-- name: GetCockpitInputManifest :one
SELECT * FROM cockpit_issue_input_manifest WHERE workspace_id=$1 AND issue_id=$2;

-- name: LockCockpitInputManifest :one
SELECT * FROM cockpit_issue_input_manifest WHERE workspace_id=$1 AND issue_id=$2 FOR UPDATE;

-- name: GetCockpitInputManifestVersion :one
SELECT * FROM cockpit_issue_input_manifest_version WHERE workspace_id=$1 AND issue_id=$2 AND id=$3;

-- name: GetCockpitInputManifestVersionByCommand :one
SELECT * FROM cockpit_issue_input_manifest_version WHERE workspace_id=$1 AND issue_id=$2 AND command_key=$3;

-- name: GetCockpitInputManifestVersionsByIDs :many
SELECT id,workspace_id,issue_id,version_number,command_key,request_hash,manifest_hash,note<>'' AS has_note,item_total,required_total,created_by,created_at
FROM cockpit_issue_input_manifest_version WHERE workspace_id=$1 AND id=ANY(sqlc.arg(ids)::uuid[]);

-- name: GetCockpitInputVersionCounts :many
SELECT input_id,count(*)::bigint AS version_total FROM cockpit_input_version
WHERE workspace_id=$1 AND input_id=ANY(sqlc.arg(ids)::uuid[]) GROUP BY input_id;

-- name: GetCockpitInputReferenceCounts :many
SELECT input_id,count(*)::bigint AS reference_total FROM cockpit_input_reference
WHERE workspace_id=$1 AND input_id=ANY(sqlc.arg(ids)::uuid[]) AND removed_at IS NULL GROUP BY input_id;

-- name: SetCockpitInputTeardownWorkspace :exec
SELECT set_config('multica.input_teardown_workspace',sqlc.arg(workspace_id)::text,true);
