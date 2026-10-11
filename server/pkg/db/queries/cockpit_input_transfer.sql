-- name: UpdateCockpitInputTransferProgress :execrows
UPDATE cockpit_input_transfer SET bytes_received=$4,lease_expires_at=now()+interval '90 seconds',updated_at=now()
WHERE workspace_id=$1 AND id=$2 AND lease_token=$3 AND state IN ('reading','pinned','writing','verifying') AND workspace_deleted_at IS NULL;

-- name: SetCockpitInputCapturing :execrows
UPDATE cockpit_input_version SET capture_state='capturing',revision=revision+1,updated_at=now()
WHERE workspace_id=$1 AND id=$2 AND active_transfer_id=$3 AND ready_at IS NULL AND capture_state<>'capturing';

-- name: ScheduleCockpitInputReconciliation :execrows
UPDATE cockpit_input_transfer SET state='verifying',lease_token=$4,lease_expires_at=now(),error_code=$5,
error_message='The stored result is not yet confirmed. The original owned object will be checked without uploading again.',revision=revision+1,updated_at=now()
WHERE workspace_id=$1 AND id=$2 AND lease_token=$3 AND state IN ('pinned','writing') AND content_hash IS NOT NULL AND finished_at IS NULL AND workspace_deleted_at IS NULL;

-- name: DeferCockpitInputReconciliation :execrows
UPDATE cockpit_input_transfer SET lease_token=$4,lease_expires_at=now()+interval '1 minute',error_code=$5,
error_message='The original stored copy cannot be checked yet. Verification will retry without uploading again; this attempt can also be explicitly abandoned.',updated_at=now()
WHERE workspace_id=$1 AND id=$2 AND lease_token=$3 AND state='verifying' AND finished_at IS NULL AND workspace_deleted_at IS NULL;

-- name: GetCockpitInputTransferWorkspaceCommand :one
SELECT * FROM cockpit_input_transfer WHERE workspace_id=$1 AND command_key=$2 AND workspace_deleted_at IS NULL;

-- name: RenewCockpitInputTransferLease :execrows
UPDATE cockpit_input_transfer SET lease_expires_at=now()+interval '90 seconds'
WHERE workspace_id=$1 AND id=$2 AND lease_token=$3 AND state IN ('reading','pinned','writing','verifying');

-- name: RecordCockpitInputSourceBefore :execrows
UPDATE cockpit_input_transfer SET source_before_root_identity=$4,source_before_file_identity=$5,source_before_size=$6,source_before_mtime_ns=$7
WHERE workspace_id=$1 AND id=$2 AND lease_token=$3 AND state='reading' AND workspace_deleted_at IS NULL;

-- name: RecordCockpitInputSourceAfter :execrows
UPDATE cockpit_input_transfer SET source_after_file_identity=$4,source_after_size=$5,source_after_mtime_ns=$6
WHERE workspace_id=$1 AND id=$2 AND lease_token=$3 AND state='reading' AND workspace_deleted_at IS NULL;

-- name: FailCockpitInputTransfer :one
UPDATE cockpit_input_transfer SET state=sqlc.arg(state)::text,error_code=sqlc.arg(error_code),error_message=sqlc.arg(error_message),
finished_at=now(),lease_token=NULL,lease_expires_at=NULL,next_attempt_at=NULL,revision=revision+1,updated_at=now(),
io_finished_at=CASE WHEN content_hash IS NULL AND state='reading' THEN COALESCE(io_finished_at,now()) ELSE io_finished_at END,
io_outcome=CASE WHEN content_hash IS NULL AND state='reading' THEN COALESCE(io_outcome,'not_started') ELSE io_outcome END,
cleanup_state='pending',cleanup_due_at=now()+interval '10 minutes'
WHERE workspace_id=$1 AND id=$2 AND lease_token=sqlc.arg(lease_token)::uuid AND finished_at IS NULL AND workspace_deleted_at IS NULL RETURNING *;

-- name: ClearCockpitInputActiveTransfer :execrows
UPDATE cockpit_input_version SET active_transfer_id=NULL,capture_state=CASE WHEN ready_at IS NULL THEN 'needs_attention' ELSE capture_state END,
capture_error_code=$5,capture_error=$6,revision=revision+1,updated_at=now()
WHERE workspace_id=$1 AND input_id=$2 AND id=$3 AND active_transfer_id=$4;

-- name: AbandonCockpitInputTransfer :one
UPDATE cockpit_input_transfer SET state='abandoned',abort_key=$4,abort_hash=$5,abort_receipt=$6,
finished_at=now(),next_attempt_at=NULL,revision=revision+1,updated_at=now(),cleanup_state='pending',cleanup_due_at=now()+interval '10 minutes',
io_finished_at=CASE WHEN content_hash IS NULL AND state IN ('awaiting_bytes','queued','reading') THEN COALESCE(io_finished_at,now()) ELSE io_finished_at END,
io_outcome=CASE WHEN content_hash IS NULL AND state IN ('awaiting_bytes','queued','reading') THEN COALESCE(io_outcome,'not_started') ELSE io_outcome END
WHERE workspace_id=$1 AND version_id=$2 AND id=$3 AND finished_at IS NULL AND workspace_deleted_at IS NULL RETURNING *;

-- name: ObserveCockpitInputLateIO :execrows
UPDATE cockpit_input_transfer SET io_finished_at=now(),io_outcome=$4,lease_token=NULL,lease_expires_at=NULL,cleanup_state='pending',cleanup_due_at=now()+interval '10 minutes'
WHERE workspace_id=$1 AND id=$2 AND lease_token=$3 AND io_finished_at IS NULL AND (finished_at IS NOT NULL OR workspace_deleted_at IS NOT NULL);

-- name: GetCockpitInputTransferCommandAnyKind :one
SELECT * FROM cockpit_input_transfer WHERE workspace_id=$1 AND input_id=$2 AND version_id=$3 AND id=$4 AND workspace_deleted_at IS NULL
AND (command_key=$5 OR finalize_key=$5 OR abort_key=$5);

-- name: LockCockpitInputVersionIdentity :one
SELECT * FROM cockpit_input_version WHERE workspace_id=$1 AND id=$2 FOR UPDATE;

-- name: QueueCockpitInputVerification :execrows
UPDATE cockpit_input_version SET availability='checking',verification_generation=verification_generation+1,
verification_lease_token=NULL,verification_lease_expires_at=NULL,verification_due_at=now()
WHERE workspace_id=$1 AND input_id=$2 AND id=$3 AND capture_state='ready'
AND verification_due_at IS NULL AND (verification_lease_token IS NULL OR verification_lease_expires_at<now());

-- name: FinishCockpitInputVerification :execrows
UPDATE cockpit_input_version SET availability=sqlc.arg(availability)::text,verification_error_code=sqlc.arg(error_code)::text,checked_at=now(),proof_expires_at=CASE WHEN sqlc.arg(availability)::text='available' THEN now()+interval '5 minutes' ELSE NULL END,
verification_lease_token=NULL,verification_lease_expires_at=NULL,verification_due_at=NULL
WHERE workspace_id=sqlc.arg(workspace_id) AND input_id=sqlc.arg(input_id) AND id=sqlc.arg(id) AND verification_generation=sqlc.arg(generation) AND verification_lease_token=sqlc.arg(lease_token)
AND current_transfer_id IS NOT DISTINCT FROM sqlc.narg(current_transfer_id)::uuid AND content_hash=sqlc.arg(content_hash)::text;
