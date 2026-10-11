-- name: ClaimCockpitInputSourceCapture :one
WITH candidate AS MATERIALIZED (
 SELECT t.id FROM cockpit_input_transfer t JOIN cockpit_input_version v ON v.workspace_id=t.workspace_id AND v.id=t.version_id AND v.active_transfer_id=t.id
 WHERE t.workspace_deleted_at IS NULL AND t.finished_at IS NULL AND t.kind='source_capture'
 AND t.state='queued' AND t.next_attempt_at<=now()
 ORDER BY t.next_attempt_at,t.id LIMIT 1 FOR UPDATE OF t SKIP LOCKED
)
UPDATE cockpit_input_transfer t SET state='reading',lease_token=$1,lease_expires_at=now()+interval '90 seconds',next_attempt_at=NULL,revision=t.revision+1,updated_at=now()
FROM candidate c WHERE t.id=c.id RETURNING t.*;

-- name: ClaimCockpitInputVerification :one
WITH candidate AS MATERIALIZED (
 SELECT id FROM cockpit_input_version WHERE capture_state='ready' AND verification_due_at<=now()
 AND verification_lease_token IS NULL ORDER BY verification_due_at,id LIMIT 1 FOR UPDATE SKIP LOCKED
)
UPDATE cockpit_input_version v SET verification_due_at=NULL,verification_lease_token=$1,verification_lease_expires_at=now()+interval '90 seconds'
FROM candidate c WHERE v.id=c.id RETURNING v.*;

-- name: RenewCockpitInputVerificationLease :execrows
UPDATE cockpit_input_version SET verification_lease_expires_at=now()+interval '90 seconds'
WHERE workspace_id=$1 AND id=$2 AND verification_lease_token=$3 AND verification_generation=$4;

-- name: ReadCockpitInputCaptureAwaitingFinalize :one
SELECT * FROM cockpit_input_transfer WHERE workspace_deleted_at IS NULL AND kind='source_capture' AND state='awaiting_finalize'
AND next_attempt_at<=now() ORDER BY next_attempt_at,id LIMIT 1;

-- name: DeferCockpitInputCaptureFinalize :execrows
UPDATE cockpit_input_transfer SET next_attempt_at=now()+interval '1 minute',error_code=$3,error_message='The verified copy is retained; its current authorization must be restored before finalization.'
WHERE workspace_id=$1 AND id=$2 AND state='awaiting_finalize' AND workspace_deleted_at IS NULL;

-- name: ClaimCockpitInputReconciliation :one
WITH candidate AS MATERIALIZED (
 SELECT t.id FROM cockpit_input_transfer t JOIN cockpit_input_version v ON v.workspace_id=t.workspace_id AND v.id=t.version_id AND v.active_transfer_id=t.id
 WHERE t.workspace_deleted_at IS NULL AND t.finished_at IS NULL AND t.content_hash IS NOT NULL
 AND t.state IN ('pinned','writing','verifying') AND t.lease_expires_at<now()
 ORDER BY t.lease_expires_at,t.id LIMIT 1 FOR UPDATE OF t SKIP LOCKED
)
UPDATE cockpit_input_transfer t SET state='verifying',lease_token=$1,lease_expires_at=now()+interval '90 seconds',revision=t.revision+1,updated_at=now()
FROM candidate c WHERE t.id=c.id RETURNING t.*;

-- name: ListCockpitInputExpiredTransfers :many
WITH waiting AS MATERIALIZED (
 SELECT workspace_id,input_id,version_id,id,lease_token,session_expires_at AS due_at FROM cockpit_input_transfer
 WHERE workspace_deleted_at IS NULL AND finished_at IS NULL AND state='awaiting_bytes' AND next_attempt_at<now() AND session_expires_at<now()
 ORDER BY next_attempt_at,id LIMIT 25
), lost AS MATERIALIZED (
 SELECT workspace_id,input_id,version_id,id,lease_token,lease_expires_at AS due_at FROM cockpit_input_transfer
 WHERE workspace_deleted_at IS NULL AND finished_at IS NULL AND state='reading' AND content_hash IS NULL AND lease_expires_at<now()
 ORDER BY lease_expires_at,id LIMIT 25
)
SELECT workspace_id,input_id,version_id,id,lease_token FROM (SELECT * FROM waiting UNION ALL SELECT * FROM lost) candidates ORDER BY due_at,id LIMIT 25;

-- name: ExpireCockpitInputTransfer :one
UPDATE cockpit_input_transfer SET state=CASE WHEN state='awaiting_bytes' THEN 'expired' ELSE 'failed' END,error_code='session_expired',error_message='The unfinished byte transfer expired. Restart with a new attempt.',
finished_at=now(),lease_token=NULL,lease_expires_at=NULL,next_attempt_at=NULL,revision=revision+1,updated_at=now(),cleanup_state='pending',cleanup_due_at=now()+interval '10 minutes',
io_finished_at=COALESCE(io_finished_at,now()),io_outcome=COALESCE(io_outcome,'not_started')
WHERE workspace_id=$1 AND id=$2 AND finished_at IS NULL AND workspace_deleted_at IS NULL AND
((state='awaiting_bytes' AND session_expires_at<now()) OR (state='reading' AND content_hash IS NULL AND lease_expires_at<now())) RETURNING *;

-- name: ClaimCockpitInputObjectCleanup :one
WITH candidate AS MATERIALIZED (
 SELECT t.id FROM cockpit_input_transfer t WHERE t.cleanup_state IN ('pending','retry_wait') AND t.cleanup_due_at<=now()
 AND (t.lease_token IS NULL OR t.lease_expires_at<now())
 AND (t.workspace_deleted_at IS NOT NULL OR t.finished_at IS NOT NULL)
 AND NOT EXISTS(SELECT 1 FROM cockpit_input_version v WHERE v.workspace_id=t.workspace_id AND v.id=t.version_id AND v.current_transfer_id=t.id)
 ORDER BY t.cleanup_due_at,t.id LIMIT 1 FOR UPDATE OF t SKIP LOCKED
)
UPDATE cockpit_input_transfer t SET cleanup_state='running',cleanup_lease_token=$1,cleanup_lease_expires_at=now()+interval '9 minutes'
FROM candidate c WHERE t.id=c.id RETURNING t.*;

-- name: QueueSupersededCockpitInputCopy :execrows
UPDATE cockpit_input_transfer t SET cleanup_state='pending',cleanup_due_at=now()
WHERE t.workspace_id=$1 AND t.version_id=$2 AND t.id=$3 AND t.state='verified' AND t.finished_at IS NOT NULL AND t.workspace_deleted_at IS NULL
AND NOT EXISTS(SELECT 1 FROM cockpit_input_version v WHERE v.workspace_id=t.workspace_id AND v.id=t.version_id AND v.current_transfer_id=t.id);

-- name: CanCleanupCockpitInputTransfer :one
SELECT EXISTS(SELECT 1 FROM cockpit_input_transfer t WHERE t.workspace_id=$1 AND t.id=$2 AND t.cleanup_lease_token=$3 AND t.cleanup_state='running'
AND (t.workspace_deleted_at IS NOT NULL OR t.finished_at IS NOT NULL)
AND NOT EXISTS(SELECT 1 FROM cockpit_input_version v WHERE v.workspace_id=t.workspace_id AND v.id=t.version_id AND v.current_transfer_id=t.id))::boolean;

-- name: FinishCockpitInputObjectCleanup :execrows
UPDATE cockpit_input_transfer SET cleanup_state=CASE WHEN sqlc.arg(cleanup_state)::text='deleted' AND io_finished_at IS NULL THEN 'pending' ELSE sqlc.arg(cleanup_state)::text END,
cleanup_due_at=CASE WHEN sqlc.arg(cleanup_state)::text='deleted' AND io_finished_at IS NOT NULL THEN NULL ELSE now()+sqlc.arg(retry_after)::interval END,cleanup_lease_token=NULL,cleanup_lease_expires_at=NULL,
cleanup_verified_at=CASE WHEN sqlc.arg(cleanup_state)::text='deleted' THEN now() ELSE cleanup_verified_at END
WHERE id=$1 AND workspace_id=$2 AND cleanup_lease_token=$3;

-- name: RecoverCockpitInputCleanupLeases :execrows
WITH candidates AS MATERIALIZED (
 SELECT id FROM cockpit_input_transfer WHERE cleanup_state='running' AND cleanup_lease_expires_at<now()
 ORDER BY cleanup_due_at,id LIMIT 25 FOR UPDATE SKIP LOCKED
)
UPDATE cockpit_input_transfer t SET cleanup_state='retry_wait',cleanup_due_at=now(),cleanup_lease_token=NULL,cleanup_lease_expires_at=NULL
FROM candidates c WHERE t.id=c.id;

-- name: RecoverCockpitInputVerificationLeases :execrows
WITH candidates AS MATERIALIZED (
 SELECT id FROM cockpit_input_version WHERE verification_lease_token IS NOT NULL AND verification_lease_expires_at<now()
 ORDER BY verification_lease_expires_at,id LIMIT 25 FOR UPDATE SKIP LOCKED
)
UPDATE cockpit_input_version v SET availability='unknown',verification_error_code='verification_timeout',verification_lease_token=NULL,verification_lease_expires_at=NULL
FROM candidates c WHERE v.id=c.id;

-- name: RetireCockpitInputWorkspaceTransfers :execrows
UPDATE cockpit_input_transfer SET workspace_deleted_at=COALESCE(workspace_deleted_at,now()),
io_finished_at=CASE WHEN content_hash IS NULL AND state IN ('awaiting_bytes','queued','reading') THEN COALESCE(io_finished_at,now()) ELSE io_finished_at END,
io_outcome=CASE WHEN content_hash IS NULL AND state IN ('awaiting_bytes','queued','reading') THEN COALESCE(io_outcome,'not_started') ELSE io_outcome END,
actor_type=NULL,actor_id=NULL,credential_owner_user_id=NULL,authorizing_user_id=NULL,source_agent_id=NULL,source_run_id=NULL,source_issue_id=NULL,source_runtime_id=NULL,
command_receipt='{}',finalize_key=NULL,finalize_hash=NULL,finalize_receipt=NULL,abort_key=NULL,abort_hash=NULL,abort_receipt=NULL,error_message='',
source_before_root_identity=NULL,source_before_file_identity=NULL,source_before_size=NULL,source_before_mtime_ns=NULL,source_after_file_identity=NULL,source_after_size=NULL,source_after_mtime_ns=NULL,
cleanup_state='pending',cleanup_due_at=now()+interval '10 minutes',next_attempt_at=NULL
WHERE workspace_id=$1 AND workspace_deleted_at IS NULL;

-- name: DeleteCockpitInputWorkspaceReferences :exec
DELETE FROM cockpit_input_reference WHERE workspace_id=$1;
-- name: DeleteCockpitInputWorkspaceManifestItems :exec
DELETE FROM cockpit_issue_input_manifest_item WHERE workspace_id=$1;
-- name: DeleteCockpitInputWorkspaceManifestVersions :exec
DELETE FROM cockpit_issue_input_manifest_version WHERE workspace_id=$1;
-- name: DeleteCockpitInputWorkspaceManifests :exec
DELETE FROM cockpit_issue_input_manifest WHERE workspace_id=$1;
-- name: DeleteCockpitInputWorkspaceVersions :exec
DELETE FROM cockpit_input_version WHERE workspace_id=$1;
-- name: DeleteCockpitInputWorkspaceHeaders :exec
DELETE FROM cockpit_input WHERE workspace_id=$1;
