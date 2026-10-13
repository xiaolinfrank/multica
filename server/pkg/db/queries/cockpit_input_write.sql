-- name: CreateCockpitInputVersion :one
INSERT INTO cockpit_input_version (id,workspace_id,input_id,version_number,submission_key,request_hash,submission_receipt,revision,actor_type,actor_id,credential_owner_user_id,authorizing_user_id,source_agent_id,source_run_id,source_issue_id,source_runtime_id,source_kind,payload_kind,source_attachment_id,source_attachment_issue_id,source_root_id,source_root_path,source_relative_path,source_root_config_hash,source_root_identity,source_file_identity,source_size,source_mtime_ns,source_artifact_id,source_artifact_version_id,filename,content_type,declared_size_bytes,client_sha256,pinned_size_bytes,content_hash,pinned_at,capture_state,active_transfer_id,ready_at,availability,created_at,updated_at)
VALUES (sqlc.arg(id),sqlc.arg(workspace_id),sqlc.arg(input_id),sqlc.arg(version_number),sqlc.arg(submission_key),sqlc.arg(request_hash),sqlc.arg(submission_receipt),sqlc.arg(revision),sqlc.arg(actor_type),sqlc.arg(actor_id),sqlc.arg(credential_owner_user_id),sqlc.arg(authorizing_user_id),sqlc.narg(source_agent_id),sqlc.narg(source_run_id),sqlc.narg(source_issue_id),sqlc.narg(source_runtime_id),sqlc.arg(source_kind),sqlc.arg(payload_kind),sqlc.narg(source_attachment_id),sqlc.narg(source_attachment_issue_id),sqlc.narg(source_root_id),sqlc.narg(source_root_path),sqlc.narg(source_relative_path),sqlc.narg(source_root_config_hash),sqlc.narg(source_root_identity),sqlc.narg(source_file_identity),sqlc.narg(source_size),sqlc.narg(source_mtime_ns),sqlc.narg(source_artifact_id),sqlc.narg(source_artifact_version_id),sqlc.arg(filename),sqlc.arg(content_type),sqlc.narg(declared_size_bytes),sqlc.narg(client_sha256),sqlc.narg(pinned_size_bytes),sqlc.narg(content_hash),sqlc.narg(pinned_at),sqlc.arg(capture_state),sqlc.narg(active_transfer_id),sqlc.narg(ready_at),sqlc.arg(availability),sqlc.arg(created_at),sqlc.arg(updated_at)) RETURNING *;

-- name: CreateCockpitInputTransfer :one
INSERT INTO cockpit_input_transfer (id,workspace_id,input_id,version_id,transfer_number,command_key,request_hash,command_receipt,actor_type,actor_id,credential_owner_user_id,authorizing_user_id,source_agent_id,source_run_id,source_issue_id,source_runtime_id,kind,mode,state,revision,replaces_transfer_id,owned_storage_key,expected_bytes,bytes_received,session_expires_at,next_attempt_at,created_at,updated_at)
VALUES (sqlc.arg(id),sqlc.arg(workspace_id),sqlc.arg(input_id),sqlc.arg(version_id),sqlc.arg(transfer_number),sqlc.arg(command_key),sqlc.arg(request_hash),sqlc.arg(command_receipt),sqlc.arg(actor_type),sqlc.arg(actor_id),sqlc.arg(credential_owner_user_id),sqlc.arg(authorizing_user_id),sqlc.narg(source_agent_id),sqlc.narg(source_run_id),sqlc.narg(source_issue_id),sqlc.narg(source_runtime_id),sqlc.arg(kind),sqlc.arg(mode),sqlc.arg(state),sqlc.arg(revision),sqlc.narg(replaces_transfer_id),sqlc.arg(owned_storage_key),sqlc.arg(expected_bytes),sqlc.narg(bytes_received),sqlc.narg(session_expires_at),sqlc.narg(next_attempt_at),sqlc.arg(created_at),sqlc.arg(updated_at)) RETURNING *;

-- name: CreateCockpitInputManifestVersion :one
INSERT INTO cockpit_issue_input_manifest_version (id,workspace_id,issue_id,version_number,command_key,request_hash,receipt,manifest_hash,note,item_total,required_total,created_by,created_at)
VALUES (sqlc.arg(id),sqlc.arg(workspace_id),sqlc.arg(issue_id),sqlc.arg(version_number),sqlc.arg(command_key),sqlc.arg(request_hash),sqlc.arg(receipt),sqlc.arg(manifest_hash),sqlc.arg(note),sqlc.arg(item_total),sqlc.arg(required_total),sqlc.arg(created_by),sqlc.arg(created_at)) RETURNING *;

-- name: NextCockpitInputVersionNumber :one
SELECT (COALESCE(max(version_number),0)+1)::integer FROM cockpit_input_version WHERE workspace_id=$1 AND input_id=$2;

-- name: NextCockpitInputTransferNumber :one
SELECT (COALESCE(max(transfer_number),0)+1)::integer FROM cockpit_input_transfer WHERE workspace_id=$1 AND version_id=$2;

-- name: SetCockpitInputCurrentVersion :one
UPDATE cockpit_input SET current_version_id=$3,revision=revision+1,updated_at=now()
WHERE workspace_id=$1 AND id=$2 AND revision=$4 RETURNING *;

-- name: SetCockpitInputActiveTransfer :one
UPDATE cockpit_input_version SET active_transfer_id=$4,capture_state=CASE WHEN ready_at IS NOT NULL THEN 'ready' ELSE sqlc.arg(capture_state)::text END,
capture_error_code='',capture_error='',revision=revision+1,updated_at=now()
WHERE workspace_id=$1 AND input_id=$2 AND id=$3 AND revision=sqlc.arg(expected_revision)::bigint RETURNING *;

-- name: CreateCockpitInputManifestHead :one
INSERT INTO cockpit_issue_input_manifest(workspace_id,issue_id,revision,current_version_id,updated_by)
VALUES($1,$2,1,$3,$4) RETURNING *;

-- name: AdvanceCockpitInputManifestHead :one
UPDATE cockpit_issue_input_manifest SET current_version_id=$3,revision=revision+1,updated_at=now(),updated_by=$4
WHERE workspace_id=$1 AND issue_id=$2 AND revision=$5 RETURNING *;

-- name: InsertCockpitInputManifestItem :exec
INSERT INTO cockpit_issue_input_manifest_item(workspace_id,manifest_version_id,position,input_version_id,purpose,required)
VALUES($1,$2,$3,$4,$5,$6);

-- name: LockCockpitInputManifestIssue :one
SELECT id,workspace_id,project_id,module_id,revision,title FROM issue WHERE workspace_id=$1 AND id=$2 FOR KEY SHARE;

-- name: PinCockpitInputTransfer :one
UPDATE cockpit_input_transfer SET state='pinned',content_hash=$6,pinned_size_bytes=$7,content_pin_at=now(),bytes_received=$7,revision=revision+1,updated_at=now()
WHERE workspace_id=$1 AND version_id=$2 AND id=$3 AND lease_token=$4 AND revision=$5 AND state='reading' AND workspace_deleted_at IS NULL RETURNING *;

-- name: PinCockpitInputVersion :one
UPDATE cockpit_input_version SET content_hash=$5,pinned_size_bytes=$6,pinned_at=now(),revision=revision+1,updated_at=now()
WHERE workspace_id=$1 AND input_id=$2 AND id=$3 AND active_transfer_id=$4 AND content_hash IS NULL RETURNING *;

-- name: ClaimCockpitInputUpload :one
UPDATE cockpit_input_transfer SET state='reading',lease_token=$6,lease_expires_at=$7,bytes_received=0,next_attempt_at=NULL,revision=revision+1,updated_at=now()
WHERE workspace_id=$1 AND input_id=$2 AND version_id=$3 AND id=$4 AND revision=$5 AND kind='direct_upload'
AND state='awaiting_bytes' AND session_expires_at>now() AND workspace_deleted_at IS NULL RETURNING *;

-- name: SetCockpitInputTransferWriting :one
UPDATE cockpit_input_transfer SET state='writing',revision=revision+1,updated_at=now()
WHERE workspace_id=$1 AND id=$2 AND lease_token=$3 AND state='pinned' AND workspace_deleted_at IS NULL RETURNING *;

-- name: CompleteCockpitInputTransferIO :one
UPDATE cockpit_input_transfer t SET state='awaiting_finalize',lease_token=NULL,lease_expires_at=NULL,io_finished_at=now(),io_outcome='verified',revision=t.revision+1,updated_at=now(),error_code='',error_message='',
next_attempt_at=CASE WHEN t.kind='source_capture' THEN now() ELSE NULL END
WHERE t.workspace_id=$1 AND t.id=$2 AND t.lease_token=$3 AND t.state IN ('writing','verifying') AND t.workspace_deleted_at IS NULL
AND EXISTS(SELECT 1 FROM cockpit_input_version v WHERE v.workspace_id=t.workspace_id AND v.input_id=t.input_id
AND v.id=t.version_id AND v.active_transfer_id=t.id AND v.content_hash=t.content_hash AND v.pinned_size_bytes=t.pinned_size_bytes) RETURNING t.*;

-- name: FinalizeCockpitInputTransfer :one
UPDATE cockpit_input_transfer SET state='verified',finalize_key=$4,finalize_hash=$5,finalize_receipt=$6,finished_at=now(),revision=revision+1,updated_at=now(),next_attempt_at=NULL,error_code='',error_message=''
WHERE workspace_id=$1 AND version_id=$2 AND id=$3 AND state='awaiting_finalize' AND workspace_deleted_at IS NULL RETURNING *;

-- name: PublishCockpitInputCopy :one
UPDATE cockpit_input_version SET current_transfer_id=$4,
accepted_transfer_id=CASE WHEN ready_at IS NULL AND source_kind<>'artifact_version' THEN $4 ELSE accepted_transfer_id END,
active_transfer_id=NULL,capture_state='ready',ready_at=COALESCE(ready_at,now()),availability='available',checked_at=now(),proof_expires_at=now()+interval '5 minutes',
verification_generation=verification_generation+1,verification_error_code='',revision=revision+1,updated_at=now()
 ,verification_lease_token=NULL,verification_lease_expires_at=NULL,verification_due_at=NULL
WHERE workspace_id=$1 AND input_id=$2 AND id=$3 AND active_transfer_id=$4 AND content_hash=$5 AND pinned_size_bytes=$6 RETURNING *;

-- name: ReadCockpitInputLatestTransfer :one
SELECT * FROM cockpit_input_transfer WHERE workspace_id=$1 AND version_id=$2 AND workspace_deleted_at IS NULL ORDER BY transfer_number DESC LIMIT 1;
