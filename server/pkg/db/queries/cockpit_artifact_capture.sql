-- name: CreateCockpitArtifactCapture :one
INSERT INTO cockpit_artifact_capture(version_id,workspace_id,artifact_id,source_attachment_id,source_storage_key,source_object_url,source_filename,source_content_type,source_size_bytes,created_by)
VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *;

-- name: GetCockpitArtifactCapture :one
SELECT * FROM cockpit_artifact_capture WHERE workspace_id=$1 AND artifact_id=$2 AND version_id=$3;

-- name: LockCockpitArtifactCapture :one
SELECT * FROM cockpit_artifact_capture WHERE workspace_id=$1 AND artifact_id=$2 AND version_id=$3 FOR UPDATE;

-- name: GetDueCockpitArtifactCapture :one
SELECT workspace_id,artifact_id,version_id FROM cockpit_artifact_capture
WHERE status IN ('queued','retry_wait','running') AND next_attempt_at<=now() AND (lease_expires_at IS NULL OR lease_expires_at<=now())
ORDER BY next_attempt_at,version_id LIMIT 1;

-- name: ClaimCockpitArtifactCapture :one
UPDATE cockpit_artifact_capture SET status='running',lease_token=sqlc.arg(lease_token),lease_expires_at=now()+interval '10 minutes',current_attempt_id=sqlc.arg(attempt_id),attempts=attempts+1,cycle_attempts=cycle_attempts+1,updated_at=now()
WHERE workspace_id=sqlc.arg(workspace_id) AND artifact_id=sqlc.arg(artifact_id) AND version_id=sqlc.arg(version_id)
 AND status IN ('queued','retry_wait','running') AND next_attempt_at<=now() AND (lease_expires_at IS NULL OR lease_expires_at<=now()) RETURNING *;

-- name: CreateCockpitArtifactCaptureAttempt :one
INSERT INTO cockpit_artifact_capture_attempt(id,workspace_id,artifact_id,version_id,attempt_number,lease_token,lease_expires_at,storage_key,object_url)
VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *;

-- name: FinishCockpitArtifactCaptureIO :one
UPDATE cockpit_artifact_capture_attempt SET state=sqlc.arg(state),content_hash=sqlc.narg(content_hash),size_bytes=sqlc.narg(size_bytes),last_error=sqlc.arg(last_error),io_finished_at=now(),updated_at=now()
WHERE id=sqlc.arg(id) AND lease_token=sqlc.arg(lease_token) RETURNING *;

-- name: CompleteCockpitArtifactCapture :one
UPDATE cockpit_artifact_capture SET status='succeeded',expected_hash=$5,lease_token=NULL,lease_expires_at=NULL,last_error_code='',last_error='',updated_at=now()
WHERE workspace_id=$1 AND artifact_id=$2 AND version_id=$3 AND lease_token=$4 AND status='running' AND lease_expires_at>now() RETURNING *;

-- name: FailCockpitArtifactCapture :one
UPDATE cockpit_artifact_capture SET status=sqlc.arg(status),expected_hash=coalesce(expected_hash,sqlc.narg(expected_hash)),last_error_code=sqlc.arg(error_code),last_error=sqlc.arg(error_message),next_attempt_at=now()+sqlc.arg(delay_seconds)::integer*interval '1 second',lease_token=NULL,lease_expires_at=NULL,updated_at=now()
WHERE workspace_id=sqlc.arg(workspace_id) AND artifact_id=sqlc.arg(artifact_id) AND version_id=sqlc.arg(version_id) AND lease_token=sqlc.arg(lease_token) AND status='running' RETURNING *;

-- name: RetryCockpitArtifactCapture :one
UPDATE cockpit_artifact_capture SET status='queued',cycle_attempts=0,next_attempt_at=now(),lease_token=NULL,lease_expires_at=NULL,last_error_code='',last_error='',updated_at=now()
WHERE workspace_id=$1 AND artifact_id=$2 AND version_id=$3 AND status IN ('retry_wait','needs_attention') RETURNING *;

-- name: QueueCockpitArtifactAttemptCleanup :exec
UPDATE cockpit_artifact_capture_attempt SET cleanup_status='pending',cleanup_next_attempt_at=now(),updated_at=now()
WHERE workspace_id=$1 AND version_id=$2 AND (sqlc.narg(except_id)::uuid IS NULL OR id<>sqlc.narg(except_id)) AND cleanup_status='live';

-- name: GetCockpitArtifactVerifiedAttempt :one
SELECT * FROM cockpit_artifact_capture_attempt WHERE workspace_id=$1 AND version_id=$2 AND state='verified' AND cleanup_status='live' ORDER BY attempt_number DESC LIMIT 1;

-- name: CockpitArtifactReferencesIssue :one
SELECT cockpit_artifact_references_issue($1::uuid,$2::uuid)::boolean AS protected;

-- name: CockpitArtifactReviewStage :one
SELECT cockpit_artifact_review_stage($1::uuid,$2::uuid)::text AS stage;

-- name: DisableCockpitArtifactCaptureForStorage :one
UPDATE cockpit_artifact_capture SET status='needs_attention',lease_token=NULL,lease_expires_at=NULL,current_attempt_id=NULL,last_error_code='private_storage_required',last_error='Configure private artifact storage before retrying this fixed file capture.',updated_at=now()
WHERE workspace_id=$1 AND artifact_id=$2 AND version_id=$3 AND status IN ('queued','running','retry_wait') AND (lease_expires_at IS NULL OR lease_expires_at<=now()) RETURNING *;
